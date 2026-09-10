/**
 * Reconocer lo que ORCA dejó atrás sin matar nada que esté vivo.
 *
 * Todo con la salida de `ps` como entrada, igual que `harness.test.ts` y por
 * el mismo motivo: en un módulo cuyo trabajo es terminar procesos, poder
 * probarlo sin terminar ninguno es la mitad de la seguridad. La otra mitad —
 * que la limpieza de verdad revalida y respeta lo vivo— se prueba contra
 * procesos desechables en `strays-live.test.ts`.
 *
 * Lo que se comprueba aquí es sobre todo lo que NO se toca. Un detector de
 * huérfanos se juzga por sus falsos positivos: dejar vivo un resto cuesta un
 * puerto, matar un servidor de desarrollo cuesta el trabajo de alguien.
 */

import { etimeToStart } from '../src/collector/hygiene.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LEASE_RENEW_MS, LEASE_STALE_MS, type Lease } from '../src/shared/lease.ts';
import {
  ORCA_ENTRYPOINTS, START_SKEW_MS, isViteCommand, orcaEntrypoint, parsePs, scanStrays, stillTheSame,
  type ProcRow, type Stray, type StrayScan,
} from '../src/shared/strays.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

const HOME = '/Users/dan';
const REPO = `${HOME}/projects/orca`;
const NOW = 1_800_000_000_000;

function scan(over: Partial<StrayScan> = {}): Stray[] {
  return scanStrays({
    procs: [], cwd: new Map(), ports: new Map(), leases: [], repo: REPO, home: HOME, now: NOW,
    own: { self: 100, parent: 99, agents: [] },
    ...over,
  });
}

function proc(over: Partial<ProcRow> & { pid: number; command: string }): ProcRow {
  return { ppid: 1, startedAt: NOW - 3_600_000, ...over };
}

const VITE = `node ${REPO}/node_modules/.bin/vite`;

/** Un lease de ORCA sobre un proceso, con su dueño. Ver shared/lease.ts. */
function lease(over: Partial<Lease> & { pid: number }): Lease {
  return {
    id: `vite-${over.pid}`, kind: 'vite', startedAt: NOW - 3_600_000, cwd: REPO,
    owner: { pid: 900, startedAt: NOW - 3_600_100, label: 'npm run dev' },
    at: NOW - 3_600_000, renewedAt: NOW - 5_000,
    ...over,
  };
}
const OTHER_VITE = '/usr/bin/node /Users/dan/projects/dijosi/node_modules/.bin/vite --port 4003';

const tests = [
  test('`ps` is read into numbers, and a line without a command is not a process', () => {
    const rows = parsePs(
      '  4321  1 01:02:03 node /x/vite\n 9  8   05:00 /bin/zsh\ngarbage\n 77 1 03:00 \n',
      NOW, etimeToStart,
    );
    return eq('three fields and the rest is the command line',
      rows.map((r) => `${r.pid}/${r.ppid}/${r.command}`),
      ['4321/1/node /x/vite', '9/8//bin/zsh']);
  }),

  test('a vite is recognised by its path in node_modules, never by the word', () => ok(
    'the word "vite" in a filename is not a vite server',
    isViteCommand(VITE)
    && isViteCommand('node /r/node_modules/vite/bin/vite.js --port 5173')
    && !isViteCommand('vim vite.config.ts')
    && !isViteCommand('grep -r vite src/')
    && !isViteCommand('node /r/node_modules/.bin/vitest'),
  )),

  test('an ORCA entrypoint is recognised, and the harness is left to its own tool', () => ok(
    'three entrypoints, and test/* is not one of them',
    orcaEntrypoint(`node tsx ${REPO}/src/hub/server.ts`, REPO) === 'src/hub/server.ts'
    && orcaEntrypoint('tsx watch src/collector/index.ts', REPO) === 'src/collector/index.ts'
    && orcaEntrypoint('npx tsx test/fake-collector.ts --hub=x', REPO) === null
    && !(ORCA_ENTRYPOINTS as readonly string[]).some((e) => e.startsWith('test/')),
  )),

  /* ── lo que SÍ es un resto ──────────────────────────────────────── */

  test('ORCA launched it, its owner is gone, its lease is stale: that is an orphan', () => {
    const [s] = scan({
      procs: [proc({ pid: 4321, command: VITE })],
      cwd: new Map([[4321, REPO]]),
      ports: new Map([[4321, [4478]]]),
      // El dueño (900) no está en `procs`: se fue.
      leases: [lease({ pid: 4321, renewedAt: NOW - LEASE_STALE_MS - 1 })],
    });
    return ok('the licence to stop it is the lease, and it says who left it behind',
      s?.verdict === 'orphan' && s.action === 'terminate' && s.kind === 'vite'
      && s.label === 'vite · :4478' && s.cwd === '~/projects/orca'
      && s.evidence.some((e) => e.includes('this repository'))
      && s.evidence.some((e) => e.includes('npm run dev') && e.includes('is gone')),
      s?.evidence.join(' · '));
  }),

  test('an ORCA entrypoint gets exactly the same treatment: no lease, no offer', () => {
    const bare = scan({ procs: [proc({ pid: 777, command: `node tsx ${REPO}/src/hub/server.ts` })] });
    const leased = scan({
      procs: [proc({ pid: 777, command: `node tsx ${REPO}/src/hub/server.ts` })],
      leases: [lease({ pid: 777, kind: 'hub', renewedAt: NOW - LEASE_STALE_MS - 1 })],
    });
    return ok('the same prudence for our own entrypoints as for a vite',
      bare[0]?.verdict === 'ambiguous' && bare[0]?.action === 'none'
      && leased[0]?.verdict === 'orphan' && leased[0]?.kind === 'orca',
      `${bare[0]?.why}`);
  }),

  /*
   * El agujero que esto cierra: `ppid === 1` NO es abandono.
   *
   * `nohup npm run dev &`, `setsid`, `disown` — todos dejan esa firma en un
   * proceso que alguien arrancó a propósito, y que puede estar sirviendo otra
   * consola en otro puerto. Ofrecerlo era ofrecer matar el servidor de alguien.
   */
  test('a nohup/detached vite of this very repo on another port is NEVER offered', () => {
    const [s] = scan({
      procs: [proc({ pid: 5150, command: VITE })],
      cwd: new Map([[5150, REPO]]),
      ports: new Map([[5150, [5199]]]),
      leases: [],
    });
    return ok('no parent is not evidence, and the panel says so instead of guessing',
      s?.verdict === 'ambiguous' && s.action === 'none'
      && s.evidence.some((e) => e.includes('no ORCA lease naming it'))
      && (s.why ?? '').includes('nohup') && (s.why ?? '').includes('did not start this'),
      s?.why);
  }),

  test('another live console of the same repo is protected, not just this one\'s port', () => {
    const [s] = scan({
      procs: [proc({ pid: 5150, command: VITE })],
      cwd: new Map([[5150, REPO]]),
      ports: new Map([[5150, [5199]]]),
      own: { self: 100, parent: 99, agents: [], consolePorts: [4478, 5199] },
    });
    return ok('a second console is somebody looking at ORCA too',
      s?.verdict === 'protected' && (s.why ?? '').includes('being served'),
      `${s?.why} · ${s?.evidence.join(' · ')}`);
  }),

  test('a lease that is still being renewed protects its process', () => {
    const [s] = scan({
      procs: [proc({ pid: 4321, command: VITE })],
      cwd: new Map([[4321, REPO]]),
      leases: [lease({ pid: 4321, renewedAt: NOW - 3_000 })],
    });
    return ok('a fresh lease is positive evidence that it is wanted',
      s?.verdict === 'protected' && s.evidence.some((e) => e.includes('renewed')), s?.evidence.join(' · '));
  }),

  test('a lease whose owner came back protects its process too', () => {
    const [s] = scan({
      procs: [
        proc({ pid: 4321, command: VITE }),
        proc({ pid: 900, ppid: 1, startedAt: NOW - 3_600_100, command: 'npm run dev' }),
      ],
      cwd: new Map([[4321, REPO]]),
      leases: [lease({ pid: 4321, renewedAt: NOW - LEASE_STALE_MS - 1 })],
    });
    return ok('the owner being alive beats a stale lease',
      s?.verdict === 'protected' && s.evidence.some((e) => e.includes('still running')), s?.evidence.join(' · '));
  }),

  test('a lease for a recycled pid does not authorise anything', () => {
    const [s] = scan({
      procs: [proc({ pid: 4321, startedAt: NOW - 60_000, command: VITE })],
      cwd: new Map([[4321, REPO]]),
      // El lease habla de un proceso que arrancó hace una hora; éste, de hace
      // un minuto. Mismo pid, otro proceso.
      leases: [lease({ pid: 4321, startedAt: NOW - 3_600_000, renewedAt: NOW - LEASE_STALE_MS - 1 })],
    });
    return ok('pid and start time, in the lease as everywhere else',
      s?.verdict === 'ambiguous' && s.evidence.some((e) => e.includes('no ORCA lease')), s?.why);
  }),

  /* ── lo que NO se toca, que es la parte que importa ─────────────── */

  test('a vite of ANOTHER project is never ORCA\'s to stop', () => {
    const [s] = scan({
      procs: [proc({ pid: 19478, command: OTHER_VITE })],
      cwd: new Map([[19478, '/Users/dan/projects/dijosi']]),
    });
    return ok('shown, with the reason, and no action',
      s?.verdict === 'protected' && s.action === 'none'
      && (s.why ?? '').includes('another project')
      && s.cwd === '~/projects/dijosi',
      s?.why);
  }),

  test('a vite whose working directory cannot be read is ambiguous, not a target', () => {
    const [s] = scan({ procs: [proc({ pid: 5, command: VITE })] });
    return ok('unidentifiable is not the same as orphaned',
      s?.verdict === 'ambiguous' && s.action === 'none' && (s.why ?? '').includes('whose vite'),
      s?.why);
  }),

  test('a vite with a live parent is somebody\'s dev server, not a leftover', () => {
    const [s] = scan({
      procs: [
        proc({ pid: 62458, ppid: 62392, command: VITE }),
        proc({ pid: 62392, ppid: 900, command: 'node node_modules/.bin/concurrently npm:dev:ui' }),
      ],
      cwd: new Map([[62458, REPO]]),
    });
    return ok('a parent is enough to disqualify it',
      s?.verdict === 'ambiguous' && s.action === 'none'
      && s.evidence.some((e) => e.includes('62392') && e.includes('alive'))
      && (s.why ?? '').includes('somebody'),
      s?.evidence.join(' · '));
  }),

  test('ORCA never offers to stop itself, its parent, or one of its agents', () => {
    const rows = scan({
      procs: [
        proc({ pid: 100, command: `node tsx ${REPO}/src/collector/index.ts` }),
        proc({ pid: 99, command: `node tsx ${REPO}/src/orca.ts` }),
        proc({ pid: 555, command: `node tsx ${REPO}/src/hub/server.ts` }),
      ],
      own: { self: 100, parent: 99, agents: [555] },
    });
    return ok('three recognised, three protected, none actionable',
      rows.length === 3 && rows.every((r) => r.verdict === 'protected' && r.action === 'none'),
      rows.map((r) => `${r.pid}:${r.verdict}`).join(' '));
  }),

  test('the vite serving this very console is protected by its port', () => {
    const [s] = scan({
      procs: [proc({ pid: 62458, command: VITE })],
      cwd: new Map([[62458, REPO]]),
      ports: new Map([[62458, [4478]]]),
      own: { self: 100, parent: 99, agents: [], consolePorts: [4478] },
    });
    return ok('the console you are looking at is never a candidate',
      s?.verdict === 'protected' && (s.why ?? '').includes('being served'), s?.why);
  }),

  test('a process without a readable start time is never a target', () => {
    const [s] = scan({
      procs: [proc({ pid: 4321, startedAt: null, command: VITE })],
      cwd: new Map([[4321, REPO]]),
    });
    return ok('no start time, no kill: a pid on its own is not an identity',
      s?.verdict === 'ambiguous' && (s.why ?? '').includes('reused'), s?.why);
  }),

  test('being old, idle or holding a port is not evidence of anything', () => {
    // Un servidor legítimo: viejo, con puerto, y con padre. Nada de eso cuenta.
    const rows = scan({
      procs: [
        proc({ pid: 700, ppid: 690, startedAt: NOW - 30 * 86_400_000, command: VITE }),
        proc({ pid: 690, ppid: 1, command: 'npm run dev' }),
      ],
      cwd: new Map([[700, REPO]]),
      ports: new Map([[700, [24678]]]),
    });
    return ok('thirty days up with two ports open is still not an orphan',
      rows[0]?.verdict === 'ambiguous' && rows[0]?.action === 'none',
      `${rows[0]?.verdict} · ${rows[0]?.why}`);
  }),

  test('everything else on the machine is invisible to this', () => eq(
    'a detector that lists node processes would be a detector that kills them',
    scan({
      procs: [
        proc({ pid: 1, command: '/sbin/launchd' }),
        proc({ pid: 2, command: 'node /Users/dan/projects/dijosi/node_modules/.bin/astro dev' }),
        proc({ pid: 3, command: '/usr/bin/ssh -N -L 4478:localhost:4478 box' }),
        proc({ pid: 4, command: 'claude --session-id abc --permission-mode auto' }),
      ],
    }).length,
    0,
  )),

  test('orphans come first: the list is read from the top', () => {
    const rows = scan({
      procs: [
        proc({ pid: 3, ppid: 2, command: VITE }),
        proc({ pid: 2, ppid: 1, command: OTHER_VITE }),
        proc({ pid: 1, command: `node tsx ${REPO}/src/orca.ts` }),
      ],
      cwd: new Map([[3, REPO], [2, '/elsewhere'], [1, REPO]]),
      leases: [lease({ pid: 1, kind: 'orca', renewedAt: NOW - LEASE_STALE_MS - 1 })],
    });
    return eq('orphan, ambiguous, protected', rows.map((r) => r.verdict), ['orphan', 'ambiguous', 'protected']);
  }),

  /* ── volver a mirar antes de matar ──────────────────────────────── */

  test('a recycled pid is refused: the identity is the pid AND the start time', () => {
    const s: Stray = {
      id: 'x', kind: 'vite', verdict: 'orphan', action: 'terminate', label: 'vite',
      pid: 4321, startedAt: NOW - 3_600_000, evidence: [],
    };
    const same = stillTheSame(s, proc({ pid: 4321, command: VITE }));
    const reused = stillTheSame(s, proc({ pid: 4321, startedAt: NOW - 10_000, command: 'node something-else' }));
    const adopted = stillTheSame(s, proc({ pid: 4321, ppid: 900, command: VITE }));
    const gone = stillTheSame(s, undefined);
    const drift = stillTheSame(s, proc({ pid: 4321, startedAt: NOW - 3_600_000 + START_SKEW_MS - 1, command: VITE }));
    return ok('same, reused, adopted, gone — and a second of clock drift is not a reuse',
      same.ok && drift.ok
      && !reused.ok && reused.why.includes('reused')
      && !adopted.ok && adopted.why.includes('parent again')
      && !gone.ok && gone.why.includes('already gone'),
      reused.ok ? '' : reused.why);
  }),

  test('the lease writer and the lease contract agree on the numbers', () => {
    // `tools/lease.mjs` es JS suelto y no puede importar el contrato, así que
    // duplica el intervalo de renovación. Dos copias de un número es como se
    // consigue que un día un lease se dé por caducado mientras se renovaba.
    const src = readFileSync(fileURLToPath(new URL('../tools/lease.mjs', import.meta.url)), 'utf8');
    const m = /const RENEW_MS = ([\d_]+);/.exec(src);
    const written = Number((m?.[1] ?? '').replace(/_/g, ''));
    return ok('one renewal interval, written twice, checked here',
      written === LEASE_RENEW_MS && written * 2 < LEASE_STALE_MS,
      `${written} vs ${LEASE_RENEW_MS}, stale at ${LEASE_STALE_MS}`);
  }),

  test('a stray with no start time cannot be revalidated, so it cannot be killed', () => {
    const s: Stray = { id: 'x', kind: 'vite', verdict: 'orphan', action: 'terminate', label: 'v', pid: 9, evidence: [] };
    const v = stillTheSame(s, proc({ pid: 9, command: VITE }));
    return ok('refused, and it says why', !v.ok && v.why.includes('pid alone'), v.ok ? '' : v.why);
  }),
];

export default { suite: 'strays · what ORCA left behind', tests } satisfies TestModule;
