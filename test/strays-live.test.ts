/**
 * El detector y la limpieza, contra procesos de verdad y desechables.
 *
 * `strays.test.ts` prueba las reglas con la salida de `ps` escrita a mano.
 * Esto arranca procesos reales, los deja huérfanos de verdad, y comprueba que
 * ORCA los reconoce y los termina — y, sobre todo, que NO toca a los que no
 * debe.
 *
 * **Nada de esto puede alcanzar a la flota real.** Todo ocurre bajo un
 * directorio temporal que hace de «repositorio», y `StrayWatch` recibe esa
 * ruta como `repo`: el repositorio de ORCA de verdad, su Vite y sus agentes
 * quedan fuera del alcance del escáner por construcción, no por cuidado. Los
 * procesos son `node` corriendo un script de dos líneas que se puede matar sin
 * consecuencias.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StrayWatch, readProcs } from '../src/collector/strays.ts';
import { leaseId, type Lease } from '../src/shared/lease.ts';
import type { TmuxHost } from '../src/collector/tmux.ts';
import { ok, test, type TestModule } from './harness.ts';

/** Un tmux que no existe: los panes tienen su propia prueba. */
const NO_TMUX = { available: () => false, list: async () => new Map() } as unknown as TmuxHost;

interface Sandbox {
  repo: string;
  other: string;
  /** El «vite» desechable: un node que duerme. */
  vite: string;
  /** Donde se apuntan los leases de esta caja. */
  leaseDir: string;
  spawned: number[];
  done(): void;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'orca-strays-'));
  const repo = join(root, 'repo');
  const other = join(root, 'other');
  // La ruta es lo que lo hace un «vite» para el detector, así que se construye
  // igual que la de verdad: <algo>/node_modules/.bin/vite
  const vite = join(repo, 'node_modules', '.bin', 'vite');
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(vite, [
    "if (process.argv.includes('--stubborn')) process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const leaseDir = join(root, 'leases');
  mkdirSync(leaseDir, { recursive: true });
  const s: Sandbox = {
    repo, other, vite, leaseDir, spawned: [],
    done() {
      for (const pid of s.spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya no está */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return s;
}

/**
 * Un proceso huérfano de verdad: lo lanza un shell que se va inmediatamente,
 * así que init lo adopta y su `ppid` pasa a ser 1. Es la única forma honesta
 * de probar esto — simular el `ppid` sería probar el simulacro.
 */
function orphan(s: Sandbox, cwd: string, args = ''): number {
  const before = new Set(pids());
  spawnSync('sh', ['-c', `node ${JSON.stringify(s.vite)} ${args} >/dev/null 2>&1 &`], { cwd, timeout: 5_000 });
  for (let i = 0; i < 60; i++) {
    const fresh = pids().filter((p) => !before.has(p));
    const mine = fresh.find((p) => cmdOf(p).includes(s.vite));
    if (mine) { s.spawned.push(mine); return mine; }
    spawnSync('sleep', ['0.05']);
  }
  throw new Error('el proceso desechable no arrancó');
}

/** Uno con padre vivo: hijo directo de esta prueba. */
function child(s: Sandbox, cwd: string): number {
  const c = spawn('node', [s.vite], { cwd, stdio: 'ignore' });
  s.spawned.push(c.pid!);
  return c.pid!;
}

function pids(): number[] {
  const r = spawnSync('ps', ['-eo', 'pid='], { encoding: 'utf8' });
  return r.stdout.split('\n').map((l) => Number(l.trim())).filter((n) => n > 0);
}

function cmdOf(pid: number): string {
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.stdout ?? '';
}

function watch(s: Sandbox): StrayWatch {
  return new StrayWatch({ tmux: NO_TMUX, agents: () => [], livenessReady: () => true, home: tmpdir(), repo: s.repo, leaseDir: s.leaseDir });
}

/**
 * Un pid que existió y ya no: se lanza algo que termina, y se espera.
 *
 * Hace falta de verdad y no inventado — el detector comprueba que el dueño no
 * está mirando `ps`, así que un número al azar podría estar en uso.
 */
function deadOwner(): number {
  const c = spawnSync('node', ['-e', '']);
  const pid = c.pid!;
  for (let i = 0; i < 40 && aliveNow(pid); i++) spawnSync('sleep', ['0.05']);
  return pid;
}
const aliveNow = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * ORCA lo lanzó, y el que lo lanzó ya no está.
 *
 * Es la ÚNICA licencia para ofrecer una terminación: sin este fichero, un
 * proceso sin padre es sólo un proceso sin padre — que es lo que dejan `nohup`,
 * `setsid` y `disown` en algo perfectamente sano.
 */
function leaseIt(s: Sandbox, pid: number, over: Partial<Lease> = {}): void {
  const startedAt = startOf(pid);
  const l: Lease = {
    id: leaseId('vite', pid), kind: 'vite', pid, startedAt, cwd: s.repo,
    owner: { pid: deadOwner(), startedAt: Date.now() - 60_000, label: 'npm run dev' },
    at: Date.now() - 600_000, renewedAt: Date.now() - 600_000,
    ...over,
  };
  writeFileSync(join(s.leaseDir, `${l.id}.json`), JSON.stringify(l));
}

/** La hora de arranque real de un pid, leída como la lee el detector. */
function startOf(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((r.stdout ?? '').trim());
  if (!m) return null;
  const d = Number(m[1] ?? 0), h = Number(m[2] ?? 0), mi = Number(m[3] ?? 0), sec = Number(m[4] ?? 0);
  return Date.now() - (((d * 24 + h) * 60 + mi) * 60 + sec) * 1000;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tests = [
  test('an orphan of this repo is found, and a live-parented one and another project\'s are not', async () => {
    const s = sandbox();
    try {
      const lost = orphan(s, s.repo);
      const owned = child(s, s.repo);
      const elsewhere = orphan(s, s.other);
      const detached = orphan(s, s.repo);     // nohup-style: sin padre y sin lease
      await wait(300);
      leaseIt(s, lost);                        // ORCA lo lanzó, y su dueño se fue

      const found = await watch(s).scan();
      const byPid = new Map(found.map((f) => [f.pid, f]));
      return ok('leased-and-abandoned is the only one offered',
        byPid.get(lost)?.verdict === 'orphan'
        && byPid.get(lost)?.action === 'terminate'
        && byPid.get(owned)?.verdict === 'ambiguous'
        && byPid.get(detached)?.verdict === 'ambiguous'
        && (byPid.get(detached)?.why ?? '').includes('nohup')
        && byPid.get(elsewhere)?.verdict === 'protected'
        && (byPid.get(elsewhere)?.why ?? '').includes('another project'),
        `${byPid.get(lost)?.verdict} / ${byPid.get(owned)?.verdict} / ${byPid.get(detached)?.verdict} / ${byPid.get(elsewhere)?.verdict}`);
    } finally { s.done(); }
  }),

  test('cleaning an orphan really ends it, and says which signal it took', async () => {
    const s = sandbox();
    try {
      const lost = orphan(s, s.repo);
      await wait(300);
      leaseIt(s, lost);
      const w = watch(s);
      const found = await w.scan();
      const target = found.find((f) => f.pid === lost)!;

      // Primero en seco: comprueba todo y no manda ninguna señal.
      const dry = await w.clean([target.id], { dryRun: true });
      const survived = alive(lost);

      const out = await w.clean([target.id]);
      await wait(200);
      return ok('dry run leaves it running; the real one ends it on SIGTERM',
        dry[0]?.result === 'stopped' && dry[0]?.detail.includes('dry run') && survived
        && out[0]?.result === 'stopped' && out[0]?.signal === 'TERM' && !alive(lost),
        `${dry[0]?.detail} → ${out[0]?.detail}`);
    } finally { s.done(); }
  }),

  test('one that ignores SIGTERM is escalated, and the escalation is reported', async () => {
    const s = sandbox();
    try {
      const stubborn = orphan(s, s.repo, '--stubborn');
      await wait(300);
      leaseIt(s, stubborn);
      const w = watch(s);
      const target = (await w.scan()).find((f) => f.pid === stubborn)!;
      const out = await w.clean([target.id]);
      await wait(200);
      return ok('SIGKILL, and it says that is what it took',
        out[0]?.result === 'stopped' && out[0]?.signal === 'KILL'
        && out[0]!.detail.includes('did not exit') && !alive(stubborn),
        out[0]?.detail);
    } finally { s.done(); }
  }),

  test('a pid that died between the scan and the click is not killed blind', async () => {
    const s = sandbox();
    try {
      const lost = orphan(s, s.repo);
      await wait(300);
      leaseIt(s, lost);
      const w = watch(s);
      const target = (await w.scan()).find((f) => f.pid === lost)!;
      // Se muere solo, como se muere un proceso mientras alguien mira un panel.
      process.kill(lost, 'SIGKILL');
      await wait(300);
      const out = await w.clean([target.id]);
      return ok('nothing was signalled, and it does not pretend it killed anything',
        out[0]?.result === 'gone' && out[0]!.detail.includes('not on the machine'),
        out[0]?.detail);
    } finally { s.done(); }
  }),

  test('a stale finding whose pid now belongs to somebody else is refused', async () => {
    const s = sandbox();
    try {
      const lost = orphan(s, s.repo);
      await wait(300);
      leaseIt(s, lost);
      const w = watch(s);
      const stale = (await w.scan()).find((f) => f.pid === lost)!;
      // El pid sigue existiendo pero el hallazgo es de otro momento: se le
      // cambia la hora de arranque, que es como se ve un pid reciclado desde
      // fuera. Es la comprobación que separa matar al tuyo de matar a un
      // desconocido.
      const forged = { ...stale, startedAt: (stale.startedAt ?? 0) - 600_000 };
      const w2 = new (class extends StrayWatch {
        override async scan() { return [forged]; }
      })({ tmux: NO_TMUX, agents: () => [], livenessReady: () => true, home: tmpdir(), repo: s.repo, leaseDir: s.leaseDir });
      const out = await w2.clean([forged.id]);
      return ok('refused, with the reason, and the process is untouched',
        out[0]?.result === 'refused' && out[0]!.detail.includes('reused') && alive(lost),
        out[0]?.detail);
    } finally { s.done(); }
  }),

  test('cleaning something the scan did not offer is refused, not obeyed', async () => {
    const s = sandbox();
    try {
      const owned = child(s, s.repo);
      await wait(300);
      const w = watch(s);
      const amb = (await w.scan()).find((f) => f.pid === owned)!;
      const out = await w.clean([amb.id]);
      return ok('an ambiguous id is not a licence',
        out[0]?.result === 'refused' && alive(owned), out[0]?.detail);
    } finally { s.done(); }
  }),

  test('a quiet agent is not a ghost: silence is never the evidence', async () => {
    const s = sandbox();
    try {
      const live = child(s, s.repo);
      const w = new StrayWatch({
        tmux: NO_TMUX, home: tmpdir(), repo: s.repo, livenessReady: () => true,
        agents: () => [
          // Callado desde hace una hora, pero su proceso está ahí: vivo.
          { sessionId: 'a1', callsign: 'K9', state: 'working', alive: false, pid: live, pane: null, updatedAt: Date.now() - 3_600_000 },
          // Sin pid conocido y sin pane: ORCA no SABE nada, y no saber no es
          // una prueba. Éste es el caso que marcó 27 agentes vivos como
          // fantasmas en la primera corrida real.
          { sessionId: 'a2', callsign: 'T4', state: 'thinking', alive: false, pid: null, pane: null, updatedAt: Date.now() - 3_600_000 },
          // Terminado: no es huérfano, es que acabó.
          { sessionId: 'a3', callsign: 'W1', state: 'done', alive: false, pid: 999_999, pane: null, updatedAt: Date.now() },
        ],
      });
      const ghosts = (await w.scan()).filter((x) => x.kind === 'agent');
      return ok('three reasons to stay quiet, zero ghosts', ghosts.length === 0,
        ghosts.map((g) => g.label).join(', '));
    } finally { s.done(); }
  }),

  test('a fresh collector that has not looked yet declares nobody a ghost', async () => {
    const s = sandbox();
    try {
      // Recién arrancado: `liveness` vacío, y toda la flota parecería muerta.
      // Es el falso positivo que la primera corrida real produjo sobre 27
      // agentes vivos, y la puerta que lo cierra.
      const w = new StrayWatch({
        tmux: NO_TMUX, home: tmpdir(), repo: s.repo, livenessReady: () => false,
        agents: () => [{ sessionId: 'a9', callsign: 'Z2', state: 'working', alive: false, pid: 999_999, pane: null, updatedAt: Date.now() }],
      });
      const ghosts = (await w.scan()).filter((x) => x.kind === 'agent');
      return ok('nothing is claimed before anything was measured', ghosts.length === 0);
    } finally { s.done(); }
  }),

  test('an agent frozen at "working" with no process and no pane is a ghost, and is retired, not killed', async () => {
    const s = sandbox();
    try {
      const w = new StrayWatch({
        tmux: NO_TMUX, home: tmpdir(), repo: s.repo, livenessReady: () => true,
        agents: () => [{ sessionId: 'a9', callsign: 'Z2', state: 'working', alive: false, pid: 999_999, pane: null, updatedAt: Date.now() - 7_200_000 }],
      });
      const found = await w.scan();
      const ghost = found.find((x) => x.kind === 'agent')!;
      const out = await w.clean([ghost.id]);
      return ok('retired through the archive flow, and nothing was signalled',
        ghost.verdict === 'orphan' && ghost.action === 'retire' && ghost.agentId === 'a9'
        && ghost.evidence.length === 3
        && out[0]?.result === 'retired' && out[0]!.detail.includes('no process was touched'),
        out[0]?.detail);
    } finally { s.done(); }
  }),

  test('the real fleet is out of reach: the scan only ever looks under its own repo', async () => {
    const s = sandbox();
    try {
      // Con `repo` apuntando al sandbox, ni el vite de ORCA ni sus procesos
      // pueden aparecer. Es la propiedad que hace segura esta suite entera.
      const found = await watch(s).scan();
      const outside = found.filter((f) => f.cwd !== undefined && !f.cwd.includes('orca-strays-'));
      const real = await readProcs();
      return ok('nothing outside the sandbox is a target',
        found.every((f) => f.verdict !== 'orphan' || (f.cwd ?? '').includes('orca-strays-'))
        && real.length > 0,
        `${found.length} found, ${outside.length} outside, ${real.length} processes on the machine`);
    } finally { s.done(); }
  }),
];

export default { suite: 'strays · against real processes', tests } satisfies TestModule;
