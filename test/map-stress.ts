/**
 * ¿Se rompe el mapa 2D antes que la utilidad de mirarlo?
 *
 * La pregunta abierta es si un grafo de flota llega a ser lo bastante denso
 * como para que 2D obligue a tantos cruces que valga la pena pagar el precio de
 * 3D. Esto no se decide argumentando: se decide mirando el peor caso y midiendo
 * lo que cuesta pintarlo.
 *
 * Inyecta flotas sintéticas de tamaño creciente directamente en el store —sin
 * hub, sin collector, sin esperar a una simulación— y para cada una registra
 * el tiempo de pintado, los nodos SVG, los cruces de aristas reales, y una
 * captura para juzgar la legibilidad con los ojos.
 *
 *   npx tsx test/map-stress.ts
 *   npx tsx test/map-stress.ts --headed
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { sleep, until } from './harness.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = join(ROOT, 'test', 'shots');
const UI_PORT = 4488;
const HUB_PORT = 4489;

const headed = process.argv.includes('--headed');
const procs: ChildProcess[] = [];

/**
 * Los escenarios. El último es deliberadamente absurdo: si el mapa aguanta ahí,
 * aguanta cualquier cosa que una persona pueda tener corriendo de verdad.
 */
const CASES = [
  { name: 'real',      projects: 5,  agents: 24,  cross: 6,   chain: 3 },
  { name: 'busy',      projects: 8,  agents: 60,  cross: 20,  chain: 5 },
  { name: 'heavy',     projects: 12, agents: 120, cross: 60,  chain: 8 },
  { name: 'absurd',    projects: 20, agents: 300, cross: 200, chain: 12 },
];

async function main() {
  await mkdir(SHOTS, { recursive: true });

  spawnProc('hub', 'npx', ['tsx', 'src/hub/server.ts'], { ORCA_PORT: String(HUB_PORT) });
  spawnProc('vite', 'npx', ['vite', '--port', String(UI_PORT), '--strictPort']);
  if (!await waitForHttp(`http://127.0.0.1:${UI_PORT}/`, 30_000)) {
    throw new Error('vite never came up');
  }

  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 140)));

  await page.goto(`http://127.0.0.1:${UI_PORT}/?noboot=1`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-view="map"]').click();
  await sleep(600);

  console.log('');
  console.log('  caso      proyectos  agentes  cruzados  cadena   pintado   nodos SVG   cruces   cruces');
  console.log('                                                                          totales    QUE');
  console.log('                                                                                  IMPORTAN');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────────');

  for (const c of CASES) {
    const m = await measure(page, c);
    console.log(
      `  ${c.name.padEnd(9)} ${String(c.projects).padStart(8)} ${String(c.agents).padStart(8)}` +
      ` ${String(c.cross).padStart(9)} ${String(c.chain).padStart(7)}` +
      ` ${(m.paintMs.toFixed(1) + 'ms').padStart(9)} ${String(m.svgNodes).padStart(11)}` +
      ` ${String(m.crossings).padStart(8)} ${String(m.loudCrossings).padStart(8)}`,
    );
    await page.screenshot({ path: join(SHOTS, `stress-${c.name}.png`) });
  }

  console.log('');
  await browser.close();
}

async function measure(page: Page, c: typeof CASES[number]) {
  return page.evaluate(async (spec) => {
    const w = window as unknown as { __orca?: { store: any } };
    const store = w.__orca!.store;

    /* ── Construir el mundo ─────────────────────────────────────────── */
    const state: any = {
      rev: 1, at: Date.now(),
      machines: {}, projects: {}, agents: {}, escalations: {},
      messages: {}, collisions: {}, keys: {},
      ceo: { messages: [], thinking: false, awaitingHuman: false },
      feed: [],
      fleet: {
        total: 0,
        byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 },
        costUSD: 0, tokensPerSec: 0, blocked: 0,
      },
    };
    state.machines['m1'] = {
      id: 'm1', hostname: 'stress', platform: 'darwin', version: '0',
      online: true, lastSeen: Date.now(), connectedAt: Date.now(),
      load: { sessions: spec.agents, activeSessions: spec.agents, cpuPct: null, memPct: null },
    };

    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const perProject = Math.ceil(spec.agents / spec.projects);
    const ids: string[] = [];

    for (let p = 0; p < spec.projects; p++) {
      const pid = `p${p}`;
      state.projects[pid] = {
        id: pid, machineId: 'm1', slug: `-p${p}`, name: `proyecto-${p}`,
        path: `/p${p}`, code: A[p % A.length]! + String(p % 10),
        gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
        rollup: {
          total: 0,
          byState: { booting: 0, thinking: 0, working: 0, blocked: 0, idle: 0, done: 0, dead: 0 },
          costUSD: 0, tokensPerSec: 0, blocked: 0,
        },
      };
      for (let i = 0; i < perProject && ids.length < spec.agents; i++) {
        const id = `a${ids.length}`;
        ids.push(id);
        // Un tercio con padre, para que haya linaje de verdad.
        const parent = i > 0 && i % 3 === 0 ? `a${ids.length - 2}` : null;
        state.agents[id] = {
          id, machineId: 'm1', projectId: pid,
          title: `tarea sintética ${ids.length}`,
          callsign: A[ids.length % A.length]! + String(ids.length % 10),
          state: 'working', block: null,
          parentId: parent, depth: parent ? 1 : 0, childIds: [], mission: null,
          model: 'claude-opus-5', tool: 'Bash', toolDetail: 'npm test',
          lastPrompt: null, lastSay: null,
          startedAt: Date.now() - 60_000, updatedAt: Date.now(), uptimeMs: 60_000,
          metrics: {
            costUSD: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
            thinkingTokens: 0, tokensPerSec: 30, linesAdded: 0, linesRemoved: 0,
            toolCalls: 0, toolDurationMs: 0, apiDurationMs: 0, turns: 1,
          },
          background: false, shortId: null,
        };
        if (parent && state.agents[parent]) state.agents[parent].childIds.push(id);
        state.projects[pid].sessionIds.push(id);
      }
      state.projects[pid].rollup.total = state.projects[pid].sessionIds.length;
      state.projects[pid].rollup.byState.working = state.projects[pid].sessionIds.length;
    }

    /* ── Cadenas de espera: A espera a B espera a C … termina en el humano ── */
    for (let c = 0; c < Math.min(spec.chain, ids.length - 1); c++) {
      const id = ids[c]!;
      const next = ids[c + 1]!;
      const last = c === spec.chain - 1;
      state.agents[id].state = 'blocked';
      state.agents[id].block = last
        ? { kind: 'question', summary: 'necesita una decisión tuya', since: Date.now() - c * 60_000 }
        : { kind: 'peer', summary: `espera a ${next}`, messageId: `m${c}`, waitingOn: next, since: Date.now() - c * 30_000 };
    }
    // Y varios bloqueados directamente contra el humano, para llenar su nodo.
    for (let i = 0; i < Math.min(10, ids.length); i++) {
      const id = ids[ids.length - 1 - i]!;
      state.agents[id].state = 'blocked';
      state.agents[id].block = {
        kind: 'question', summary: `pregunta ${i}`, since: Date.now() - i * 45_000,
      };
    }

    /* ── Tráfico cruzado: el caso que 3D dice resolver mejor ────────── */
    for (let k = 0; k < spec.cross; k++) {
      const from = ids[(k * 7) % ids.length]!;
      const to = ids[(k * 13 + 5) % ids.length]!;
      if (from === to) continue;
      state.messages[`msg${k}`] = {
        id: `msg${k}`, kind: 'notice', scope: 'agent',
        fromAgentId: from, fromCallsign: state.agents[from].callsign,
        fromProjectId: state.agents[from].projectId,
        toAgentId: to, toProjectId: null,
        subject: `dato cruzado ${k}`, body: null, files: [],
        at: Date.now(), readBy: [], expiresAt: null,
        answer: null, answeredAt: null, answeredBy: null,
      };
    }

    /* ── Medir ──────────────────────────────────────────────────────── */
    const t0 = performance.now();
    store.replaceWorld(state);
    // Dejar que el pintado síncrono termine antes de parar el reloj.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const paintMs = performance.now() - t0;

    const svg = document.querySelector('.map__svg')!;
    const svgNodes = svg.querySelectorAll('*').length;

    /* Cruces reales entre aristas. Es el número que decide el argumento: si es
       bajo, la ventaja de 3D para grafos densos no aplica aquí. */
    const paths = [...svg.querySelectorAll<SVGPathElement>('path')];
    const segs: { x1: number; y1: number; x2: number; y2: number; loud: boolean }[] = [];
    for (const p of paths) {
      // Una arista "ruidosa" es la que el operador tiene que seguir con el ojo:
      // una espera. El resto es fondo, y un cruce en el fondo no cuesta nada.
      const loud = /--(ask|human|collision)/.test(p.getAttribute('class') ?? '');
      const d = p.getAttribute('d') ?? '';
      // Los caminos son ortogonales: se reconstruyen los tramos desde el path.
      const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      let cx = nums[0] ?? 0, cy = nums[1] ?? 0;
      const cmds = d.match(/[MHV]\s*-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?)?/g) ?? [];
      for (const cmd of cmds.slice(1)) {
        const v = Number(cmd.slice(1).trim().split(/\s+/)[0]);
        if (cmd[0] === 'H') { segs.push({ x1: cx, y1: cy, x2: v, y2: cy, loud }); cx = v; }
        else if (cmd[0] === 'V') { segs.push({ x1: cx, y1: cy, x2: cx, y2: v, loud }); cy = v; }
        else { cx = v; }
      }
    }
    let crossings = 0;
    let loudCrossings = 0;
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i]!;
      const aH = a.y1 === a.y2;
      for (let j = i + 1; j < segs.length; j++) {
        const b = segs[j]!;
        const bH = b.y1 === b.y2;
        if (aH === bH) continue;   // paralelos: no se cruzan
        const h = aH ? a : b;
        const v = aH ? b : a;
        const hx1 = Math.min(h.x1, h.x2), hx2 = Math.max(h.x1, h.x2);
        const vy1 = Math.min(v.y1, v.y2), vy2 = Math.max(v.y1, v.y2);
        if (v.x1 > hx1 && v.x1 < hx2 && h.y1 > vy1 && h.y1 < vy2) {
          crossings++;
          // Sólo cuenta de verdad si el operador tiene que desenredarlo: un
          // cruce entre dos aristas de fondo no le cuesta nada.
          if (a.loud && b.loud) loudCrossings++;
        }
      }
    }

    return { paintMs, svgNodes, crossings, loudCrossings };
  }, c);
}

/* ── Plumbing ─────────────────────────────────────────────────────── */

function spawnProc(label: string, cmd: string, argv: string[], env: Record<string, string> = {}) {
  const p = spawn(cmd, argv, {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr?.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (/EADDR|Error:/.test(s)) console.error(`  [${label}]`, s.slice(0, 200));
  });
  procs.push(p);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  return until(async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.ok || r.status === 404;
    } catch { return false; }
  }, timeoutMs, 300);
}

function shutdown() {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
}
process.on('SIGINT', () => { shutdown(); process.exit(130); });

main()
  .then(() => { shutdown(); process.exit(0); })
  .catch((err) => { console.error('[stress] failed:', err); shutdown(); process.exit(1); });
