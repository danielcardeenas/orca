/**
 * El cierre del proceso de un agente, contra procesos de verdad y desechables.
 *
 * `reap.test.ts` prueba las reglas con filas de `ps` escritas a mano. Esto
 * arranca procesos reales —un `node` que ignora Ctrl-C y SIGHUP, como hace un
 * CLI de verdad cuando su pane se cierra debajo— y comprueba que ORCA los
 * cierra cuando debe y, sobre todo, que NO toca los que no debe: una sesión
 * externa con la misma forma, un pid reciclado, una sesión que sigue viva.
 *
 * **Nada de esto puede alcanzar a la flota real.** Los agentes que el reaper
 * ve son los que le da `deps.agent`, que aquí es un mapa de la prueba; los
 * procesos son hijos de esta prueba; y el tmux real que se usa al final corre
 * en un socket privado (`orca-reap-<pid>`) que se destruye al terminar. El
 * `claude` que aparece en un argv es un enlace simbólico a `node` en un
 * directorio temporal.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CommandRunner, type AgentHandle, type CommandDeps } from '../src/collector/commands.ts';
import { LineageIndex } from '../src/collector/lineage.ts';
import { SessionReaper, SWEEP_SETTLE_MS, readRow, type ReapAgentView } from '../src/collector/reap.ts';
import { TmuxHost } from '../src/collector/tmux.ts';
import type { StopOutcome } from '../src/shared/reap.ts';
import { ok, test, type TestModule } from './harness.ts';

/* ── la caja ─────────────────────────────────────────────────────── */

interface Box {
  root: string;
  /** El script del «agente»: ignora Ctrl-C y SIGHUP; con --stubborn también SIGTERM. */
  agent: string;
  /** `<root>/bin/claude` → node, para que un argv tenga la forma de un claude. */
  claude: string;
  spawned: number[];
  done(): void;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'orca-reap-'));
  const agent = join(root, 'agent.js');
  writeFileSync(agent, [
    "process.on('SIGINT', () => {}); process.on('SIGHUP', () => {});",
    "if (process.argv.includes('--stubborn')) process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  mkdirSync(join(root, 'bin'));
  const claude = join(root, 'bin', 'claude');
  symlinkSync(process.execPath, claude);
  const b: Box = {
    root, agent, claude, spawned: [],
    done() {
      for (const pid of b.spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* ya no está */ } }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return b;
}

/**
 * Un «agente» hijo de esta prueba. Por defecto se lanza a través del enlace
 * `claude`, para que su argv tenga la forma que la lista permitida reconoce:
 * con `node` a secas el reaper lo rechaza como «no es un runtime», y eso es
 * lo que la última prueba comprueba.
 */
function child(b: Box, args: string[] = [], bin: 'claude' | 'node' = 'claude'): number {
  const c = spawn(bin === 'claude' ? b.claude : 'node', [b.agent, ...args], { stdio: 'ignore', detached: true });
  c.unref();
  b.spawned.push(c.pid!);
  return c.pid!;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Hasta que `ps` lo lista: recién lanzado, un pid puede no tener fila aún. */
async function settled(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
    if ((r.stdout ?? '').trim()) break;
    await wait(50);
  }
  // Y un respiro: un node que aún no instaló sus manejadores muere a la primera señal.
  await wait(300);
}

/* ── el reaper con dobles ─────────────────────────────────────────── */

interface World {
  agents: Map<string, ReapAgentView>;
  panes: Set<string>;
  alivePids: number[];
  feed: string[];
  now: number;
}

function world(): World {
  return { agents: new Map(), panes: new Set(), alivePids: [], feed: [], now: Date.now() };
}

function reaper(w: World, over: { sweepSettleMs?: number; tmux?: TmuxHost } = {}): SessionReaper {
  return new SessionReaper({
    tmux: over.tmux ?? ({ available: () => false, list: async () => new Map() } as unknown as TmuxHost),
    agent: (id) => w.agents.get(id) ?? null,
    sessionIds: () => [...w.agents.keys()],
    alivePids: () => w.alivePids,
    panes: () => w.panes,
    refresh: async () => { /* el mundo lo mueve la prueba */ },
    livenessReady: () => true,
    feed: (level, text) => { w.feed.push(`${level}: ${text}`); },
    repo: join(tmpdir(), 'not-the-orca-repo'),
    ...(over.sweepSettleMs !== undefined ? { sweepSettleMs: over.sweepSettleMs } : {}),
  });
}

const orcaAgent = (callsign: string, over: Partial<ReapAgentView> = {}): ReapAgentView =>
  ({ callsign, origin: 'orca', role: 'agent', subagent: false, state: 'done', alive: false, ...over });

/* ── las pruebas ─────────────────────────────────────────────────── */

const tests = [
  test('an external session with exactly the same process shape is never touched', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      // Lo mismo que un agente de ORCA en todo, menos en la procedencia.
      w.agents.set(sid, orcaAgent('orca-f0', { origin: 'external' }));
      const r = reaper(w);
      r.note(sid, pid, 'cli'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      await wait(200);
      return ok('kept as external, and the process is untouched',
        out.result === 'kept' && out.reason === 'external' && alive(pid) && w.feed.length === 0, out.why);
    } finally { b.done(); }
  }),

  test('a session with no verified provenance is treated as external', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9', { origin: undefined }));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      return ok('kept, untouched', out.result === 'kept' && out.reason === 'external' && alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('a recycled pid is not closed: the number is the same, the process is not', async () => {
    const b = box(); const w = world();
    try {
      const first = child(b); await settled(first);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w);
      r.note(sid, first, 'pane'); await r.remember();
      const known = r.known(sid)!;
      // El pid se recicla: ahora lo tiene OTRO proceso (otra orden, otra hora).
      // Se ve desde fuera exactamente así, y se construye así.
      const other = child(b, ['--other']); await settled(other);
      const procs = (r as unknown as { procs: Map<string, typeof known> }).procs;
      procs.set(sid, { ...known, pid: other });
      const byCommand = await r.afterStop(sid, { settleMs: 0 });
      const otherRow = await readRow(other);
      procs.set(sid, { ...known, pid: other, command: otherRow!.command, startedAt: (known.startedAt ?? 0) - 600_000 });
      const byTime = await r.afterStop(sid, { settleMs: 0 });
      return ok('refused twice as reused, and both processes live on',
        byCommand.result === 'kept' && byCommand.reason === 'reused' && byCommand.why.includes('different command')
        && byTime.result === 'kept' && byTime.reason === 'reused' && byTime.why.includes('different time')
        && alive(first) && alive(other),
        `${byCommand.why} | ${byTime.why}`);
    } finally { b.done(); }
  }),

  test('a session that is still alive keeps its process, whatever the caller thinks', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9', { alive: true, state: 'working' }));
      w.panes.add(`orca-${sid}`);
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 300 });
      w.panes.clear();
      const listed = await r.afterStop(sid, { settleMs: 300 });
      return ok('pane alive → kept; CLI still listing → kept; nothing signalled',
        out.result === 'kept' && out.reason === 'session-alive' && out.why.includes('tmux server')
        && listed.result === 'kept' && listed.reason === 'session-alive' && listed.why.includes('still lists')
        && alive(pid), `${out.why} | ${listed.why}`);
    } finally { b.done(); }
  }),

  test('a pid the liveness lists alive is untouchable even when its own session ended', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      w.alivePids = [pid];
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      return ok('untouchable', out.result === 'kept' && out.reason === 'untouchable' && alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('CAPCOM is never closed from here', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('CAPCOM', { role: 'capcom' }));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      return ok('capcom kept', out.result === 'kept' && out.reason === 'capcom' && alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('after a stop, a survivor is freed on SIGTERM, its bytes are reported, and the feed records it', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const dry = await r.afterStop(sid, { settleMs: 0, dryRun: true });
      const stillThere = alive(pid);
      const out = await r.afterStop(sid, { settleMs: 0 });
      await wait(200);
      return ok('dry run keeps it; the real one frees it on TERM with rss > 0 and one feed line',
        dry.result === 'kept' && dry.why.includes('dry run') && stillThere
        && out.result === 'freed' && out.signal === 'TERM' && out.pid === pid && (out.rssBytes ?? 0) > 0
        && !alive(pid) && r.known(sid) === null
        && w.feed.length === 1 && w.feed[0]!.includes('liberado') && w.feed[0]!.startsWith('info:'),
        `${dry.why} → ${out.why} · ${w.feed.join(' | ')}`);
    } finally { b.done(); }
  }),

  test('one that ignores SIGTERM is escalated to SIGKILL, and the escalation is reported', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b, ['--stubborn']); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      await wait(200);
      return ok('KILL, said out loud', out.result === 'freed' && out.signal === 'KILL' && out.why.includes('did not exit') && !alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('a process that died between the stop and the check is reported gone, not killed and not failed', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      process.kill(pid, 'SIGKILL'); await wait(300);
      const out = await r.afterStop(sid, { settleMs: 0 });
      return ok('gone', out.result === 'gone' && out.pid === pid && w.feed.length === 0, out.why);
    } finally { b.done(); }
  }),

  test('a session ORCA never saw a pid for gets an honest unknown, never a guess', async () => {
    const w = world();
    const sid = randomUUID();
    w.agents.set(sid, orcaAgent('K9'));
    const out = await reaper(w).afterStop(sid, { settleMs: 0 });
    return ok('unknown', out.result === 'unknown' && out.why.includes('never observed'), out.why);
  }),

  test('a claude left from before a collector restart is found by the session id on its argv, and closed', async () => {
    const b = box(); const w = world();
    try {
      const sid = randomUUID();
      const pid = child(b, ['--session-id', sid]); await settled(pid);
      w.agents.set(sid, orcaAgent('K9'));
      // Un reaper recién nacido: no recuerda nada. Tiene que encontrarlo solo.
      const r = reaper(w);
      const out = await r.afterStop(sid, { settleMs: 0 });
      await wait(200);
      return ok('discovered by argv and freed', out.result === 'freed' && out.pid === pid && !alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('the sweep waits for the session to have been over for a while, then frees it; a stop in flight is not raced', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9', { alive: true }));
      w.panes.add(`orca-${sid}`);
      const r = reaper(w, { sweepSettleMs: 1_000 });   // reloj real: uno falso desplaza el startedAt calculado desde etime
      r.note(sid, pid, 'pane'); await r.remember();
      const running = await r.sweep();                    // viva: nada
      w.panes.clear(); w.agents.set(sid, orcaAgent('K9'));
      const justEnded = await r.sweep();                  // acaba de terminar: se apunta, no se toca
      await wait(400);
      const early = await r.sweep();                      // aún no
      const wasAlive = alive(pid); await wait(800);
      const late = await r.sweep();                       // ya
      await wait(200);
      return ok('nothing, nothing, nothing, freed',
        running.length === 0 && justEnded.length === 0 && early.length === 0 && wasAlive && !alive(pid)
        && late.length === 1 && late[0]!.result === 'freed',
        `${running.length}/${justEnded.length}/${early.length}/${late.map((x) => x.result).join(',')}`);
    } finally { b.done(); }
  }),

  test('a background session that ends on its own is shown, not swept: from outside "not listed" is not proof', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w, { sweepSettleMs: 100 });
      r.note(sid, pid, 'cli'); await r.remember();
      await r.sweep(); await wait(300);
      const swept = await r.sweep();
      const shown = (await r.scan()).find((s) => s.agentId === sid);
      const stopped = await r.afterStop(sid, { settleMs: 0 });   // pero un stop explícito sí lo autoriza
      await wait(200);
      return ok('sweep leaves it; scan shows it protected with the reason; an explicit stop frees it',
        swept.length === 0 && shown?.verdict === 'protected' && (shown.why ?? '').includes('background')
          && stopped.result === 'freed' && !alive(pid),
        `${swept.length} swept · ${shown?.verdict}: ${shown?.why} · ${stopped.result}`);
    } finally { b.done(); }
  }),

  test('the hygiene scan lists a stopped session with its cost, protects the rest, and skips a normal running agent', async () => {
    const b = box(); const w = world();
    try {
      const stopped = child(b); const external = child(b); const running = child(b);
      await settled(stopped); await settled(external); await settled(running);
      const s1 = randomUUID(); const s2 = randomUUID(); const s3 = randomUUID();
      w.agents.set(s1, orcaAgent('K9'));
      w.agents.set(s2, orcaAgent('orca-f0', { origin: 'external', state: 'idle' }));
      w.agents.set(s3, orcaAgent('T4', { alive: true, state: 'working' }));
      w.panes.add(`orca-${s3}`);
      const r = reaper(w);
      r.note(s1, stopped, 'pane'); r.note(s2, external, 'cli'); r.note(s3, running, 'pane');
      await r.remember();
      const found = await r.scan();
      const a = found.find((s) => s.agentId === s1); const e = found.find((s) => s.agentId === s2); const t = found.find((s) => s.agentId === s3);
      const cleaned = await r.clean(a!.id);
      const missing = await r.clean('stray_session_nobody');
      await wait(200);
      return ok('orphan with bytes · external protected · running absent · clean frees by id · unknown id is gone',
        a?.kind === 'session' && a.verdict === 'orphan' && a.action === 'terminate' && (a.rssBytes ?? 0) > 0 && a.label.includes('retained')
        && e?.verdict === 'protected' && (e.why ?? '').includes('external')
        && t === undefined
        && cleaned.result === 'stopped' && cleaned.signal === 'TERM' && !alive(stopped) && alive(external) && alive(running)
        && missing.result === 'gone',
        `${a?.label} / ${e?.verdict} / ${t?.verdict ?? 'absent'} / ${cleaned.detail} / ${missing.result}`);
    } finally { b.done(); }
  }),

  test('stop through the command runner, against a real pane on a private socket: the session ends, the survivor is freed, the ack says both', async () => {
    const tmux = new TmuxHost(`orca-reap-${process.pid}`);
    if (!tmux.available()) return ok('tmux is not on this machine: the pane leg is not exercised here', true);
    const b = box(); const w = world();
    const sid = randomUUID();
    const pane = `orca-${sid}`;
    try {
      const up = await tmux.spawn({ name: pane, cwd: b.root, env: { PATH: process.env['PATH'] ?? '' }, argv: [b.claude, b.agent] });
      if (!up.ok) return ok(`could not open a pane: ${up.detail}`, false);
      let info = (await tmux.list()).get(pane);
      for (let i = 0; i < 40 && (!info || info.pid === null); i++) { await wait(100); info = (await tmux.list()).get(pane); }
      const pid = info?.pid ?? null;
      if (pid === null) return ok('the pane never reported a pid', false);
      b.spawned.push(pid);
      await settled(pid);

      w.agents.set(sid, orcaAgent('K9', { alive: true, state: 'working' }));
      const refresh = async () => {
        const list = await tmux.list();
        w.panes = new Set([...list].filter(([, i]) => !i.dead).map(([n]) => n));
        if (!w.panes.has(pane)) w.agents.set(sid, orcaAgent('K9'));
      };
      await refresh();
      const r = new SessionReaper({
        tmux, agent: (id) => w.agents.get(id) ?? null, sessionIds: () => [...w.agents.keys()],
        alivePids: () => [], panes: () => w.panes, refresh, livenessReady: () => true,
        feed: (level, text) => { w.feed.push(`${level}: ${text}`); }, repo: join(tmpdir(), 'not-the-orca-repo'),
      });
      r.note(sid, pid, 'pane'); await r.remember();

      const a: AgentHandle = { id: sid, projectId: 'p1', sessionId: sid, shortId: null, background: false, alive: true, callsign: 'K9', pane, runtime: 'claude', origin: 'orca' };
      const runner = new CommandRunner({
        projects: { get: () => ({ id: 'p1', name: 'proyecto', path: b.root }) }, keys: { materialize: () => ({}) },
        tmux, lineage: new LineageIndex(join(b.root, 'lineage.json')), escalations: {}, messages: {}, artifacts: {},
        agent: (id: string) => (id === sid ? a : null), awaitSpawn: async () => null,
        onResync: () => {}, onKeysChanged: () => {}, reaper: () => r,
      } as unknown as CommandDeps);

      const started = Date.now();
      const res = await runner.execute({ k: 'stop', agentId: sid });
      const took = Date.now() - started;
      const data = res.data as StopOutcome;
      await wait(200);
      const paneLeft = (await tmux.list()).has(pane);
      return ok('ok with session stopped and process freed; the pane is gone; the survivor is dead; both parts in the detail',
        res.ok && data.session.stopped && data.process.result === 'freed' && data.process.pid === pid
        && (res.detail ?? '').includes('sesión detenida') && (res.detail ?? '').includes('liberado')
        && !paneLeft && !alive(pid) && took < 25_000,
        `${res.detail} (${took}ms)`);
    } finally {
      await tmux.killServer();
      b.done();
    }
  }),

  test('a process that is not one of the runtimes ORCA launches is refused, whatever its session says', async () => {
    const b = box(); const w = world();
    try {
      const pid = child(b, [], 'node'); await settled(pid);
      const sid = randomUUID();
      w.agents.set(sid, orcaAgent('K9'));
      const r = reaper(w);
      r.note(sid, pid, 'pane'); await r.remember();
      const out = await r.afterStop(sid, { settleMs: 0 });
      return ok('not-a-runtime, untouched', out.result === 'kept' && out.reason === 'not-a-runtime' && alive(pid), out.why);
    } finally { b.done(); }
  }),

  test('stop without a reaper mounted behaves as before and claims nothing about the process', async () => {
    const calls: string[] = [];
    let present = true;
    const tmux = {
      available: () => true,
      has: async () => present,
      keys: async (_p: string, k: string[]) => { calls.push(`keys:${k.join('+')}`); if (calls.length >= 2) present = false; return { ok: true, stdout: '', detail: '' }; },
      kill: async () => { calls.push('kill'); present = false; return { ok: true, stdout: '', detail: '' }; },
    } as unknown as TmuxHost;
    const a: AgentHandle = { id: 's1', projectId: 'p1', sessionId: 's1', shortId: null, background: false, alive: true, callsign: 'K9', pane: 'orca-s1-abcd', runtime: 'claude' };
    const runner = new CommandRunner({
      projects: { get: () => null }, keys: { materialize: () => ({}) }, tmux,
      lineage: new LineageIndex(join(mkdtempSync(join(tmpdir(), 'orca-reap-')), 'lineage.json')),
      escalations: {}, messages: {}, artifacts: {}, agent: (id: string) => (id === 's1' ? a : null),
      awaitSpawn: async () => null, onResync: () => {}, onKeysChanged: () => {},
    } as unknown as CommandDeps);
    const res = await runner.execute({ k: 'stop', agentId: 's1' });
    return ok('two Ctrl-C, no kill needed, ok, and no word about a process',
      res.ok && calls.join(',') === 'keys:C-c,keys:C-c' && (res.detail ?? '').includes('Ctrl-C') && res.data === undefined,
      `${calls.join(',')} · ${res.detail}`);
  }),
];

export default { suite: 'reap · against real processes', tests } satisfies TestModule;
