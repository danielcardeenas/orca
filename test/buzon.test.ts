/**
 * El buzón: que un mensaje perdido se pueda distinguir de uno sin contestar, y
 * que una pregunta colgada no dependa de que alguien vaya a buscarla.
 *
 * Las tres cosas que se prueban aquí son las tres que fallaron el 2026-09-13, y
 * cada una existe porque su ausencia costó una mañana:
 *
 *  1. **La raíz.** Un agente dentro de un `git worktree` escribía su buzón en
 *     un directorio que nadie vigila, porque los CLI resolvían el proyecto con
 *     `git rev-parse --show-toplevel` mientras el collector lo plegaba al repo
 *     padre. Quince mensajes se quedaron en disco, tres de ellos respuestas a
 *     preguntas bloqueantes, y sus destinatarios esperaron cuarenta minutos.
 *
 *  2. **La diferencia entre perdido y sin contestar.** Los dos se veían igual
 *     desde fuera: silencio. `orca-tell` imprimía `sent:` por haber escrito un
 *     fichero en su propio disco y nadie podía saber más. Ésta es la prueba que
 *     CAPCOM pidió por su nombre, y la que defiende al recibo de un refactor
 *     que lo vea como ruido.
 *
 *  3. **Que la pregunta colgada se vea sola.** El caso se salvó porque un líder
 *     leyó el disco por costumbre. Una costumbre no es un mecanismo: basta un
 *     líder que no la tenga. Lo que no aparece en el briefing, no se debe.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { Agent, AgentMessage, Project } from '../src/shared/types.ts';
import { runTool, type CeoContext } from '../src/agents/tools.ts';
import { foldWorktree, projectRoot } from '../bin/lib/project-root.mjs';
import {
  describeReceipt, readReceipt, sweepReceipts, writeReceipt, PICKUP_GRACE_MS, type Receipt,
} from '../bin/lib/receipt.mjs';
import { foldWorktreeSlug } from '../src/collector/projects.ts';
import { pathToSlug } from '../src/shared/workspaces.ts';
import { ok, test, type TestModule } from './harness.ts';

const NOW = Date.now();
const MIN = 60_000;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: over.id ?? 'a1', machineId: 'm1', projectId: 'p1',
    title: 'test', callsign: 'K1', runtime: 'claude', state: 'working', block: null,
    parentId: null, depth: 0, childIds: [], mission: null,
    squad: null, lead: false,
    model: null, tool: null, toolDetail: null,
    lastPrompt: null, lastSay: null, startedAt: NOW - 3600_000, updatedAt: NOW, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', machineId: 'm1', slug: '-tmp-orca', name: 'orca', path: '/tmp/orca', code: 'OR',
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: {
      total: 1, blocked: 0, tokens: 0, tokensPerSec: 0,
      byState: { booting: 0, thinking: 0, working: 1, blocked: 0, idle: 0, done: 0, dead: 0 },
    },
    ...over,
  };
}

function message(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'msg_1', kind: 'ask', scope: 'agent',
    fromAgentId: 'a1', fromCallsign: 'K1', fromProjectId: 'p1',
    toAgentId: 'a2', toProjectId: null, toSquad: null,
    subject: '¿Puedo tocar test/files.test.ts?', body: null, files: [],
    at: NOW - 40 * MIN, readBy: [], expiresAt: null,
    answer: null, answeredAt: null, answeredBy: null,
    ...over,
  };
}

/** Un mundo en una caja: sólo lo que `briefing` lee. Lo demás se niega. */
function ctx(o: { agents?: Agent[]; projects?: Project[]; messages?: AgentMessage[] }): CeoContext {
  const agents = o.agents ?? [];
  const projects = o.projects ?? [];
  const refuse = (): never => { throw new Error('not in this test'); };
  return {
    agents: () => agents,
    projects: () => projects,
    agent: (id) => agents.find((a) => a.id === id),
    project: (id) => projects.find((p) => p.id === id),
    escalation: () => undefined,
    escalations: () => [],
    rules: () => [],
    dispatch: refuse, nextSquadName: refuse, fleets: () => [],
    recall: () => [], remember: refuse, raiseToHuman: refuse, resolveEscalation: refuse,
    messages: () => o.messages ?? [], message: () => undefined, collisions: () => [],
    relay: refuse, answerPeer: refuse, acknowledgeCollision: refuse, archiveAgents: refuse,
  };
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    msgId: 'tell_x', state: 'filed', to: 'K9', kind: 'ask',
    recipients: [], detail: null, at: NOW, updatedAt: NOW,
    ...over,
  };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orca-buzon-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const tests = [
  /* ── 1. la raíz ─────────────────────────────────────────────────── */

  test('a worktree resolves to the project the collector actually watches', () => {
    const main = '/Users/dan/projects/orca';
    const tree = `${main}/.claude/worktrees/forge-buzon-01`;
    // El plegado tiene que coincidir con el del collector, no parecerse: son
    // los dos extremos del mismo canal, y en cuanto discrepan el buzón se
    // parte sin que nadie lo note.
    const folded = foldWorktree(tree);
    const collectorFolded = foldWorktreeSlug(pathToSlug(tree));
    return ok(
      'the CLI folds a worktree exactly where foldWorktreeSlug does',
      folded === main && pathToSlug(folded) === collectorFolded,
      `cli=${folded} collector=${collectorFolded}`,
    );
  }),

  test('a plain checkout is left alone, and --project always wins', () => {
    const plain = '/Users/dan/projects/orca';
    return ok(
      'only a worktree is folded; an explicit --project is never second-guessed',
      foldWorktree(plain) === plain && projectRoot('/somewhere/else') === '/somewhere/else',
    );
  }),

  test('a real git worktree files its mail in the main checkout', () => withDir((dir) => {
    // Un worktree de verdad, no una ruta inventada: lo que se está probando es
    // el acuerdo con git, y una cadena hecha a mano no lo prueba.
    // realpath porque en macOS /var es un symlink a /private/var y git
    // devuelve siempre la ruta resuelta: comparar sin resolver falla por el
    // symlink y no por lo que se está probando.
    const repo = join(realpathSync(dir), 'repo');
    mkdirSync(repo, { recursive: true });
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    run('init', '-q');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'test');
    writeFileSync(join(repo, 'README'), 'x');
    run('add', 'README');
    run('commit', '-qm', 'first');
    const tree = join(repo, '.claude', 'worktrees', 'w1');
    run('worktree', 'add', '-q', '-b', 'w1', tree);

    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: tree, encoding: 'utf8',
    }).trim();
    // La línea que estaba en los seis CLI devuelve el worktree; la nueva, el
    // repo. Ésa es, literalmente, toda la diferencia entre el canal roto y el
    // canal que funciona.
    return ok(
      'git says the worktree, projectRoot says the repo the collector watches',
      toplevel !== repo && projectRoot(null, tree) === repo,
      `toplevel=${toplevel} root=${projectRoot(null, tree)}`,
    );
  })),

  /* ── 2. perdido ≠ sin contestar ─────────────────────────────────── */

  /*
   * La prueba que CAPCOM pidió por su nombre.
   *
   * Los dos casos se veían igual desde el emisor: silencio. Uno se arregla
   * yendo a buscar el fichero al disco; el otro, insistiendo a una persona. Sin
   * poder distinguirlos, la respuesta racional a cualquier silencio es esperar,
   * que es exactamente lo que falló.
   */
  test('a message nobody picked up is distinguishable from one nobody answered', () => withDir((dir) => {
    const old = NOW - 10 * MIN;
    // El buzón de salida, con el mensaje perdido todavía dentro: ésa es la
    // prueba en disco de que nadie se lo llevó.
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'tell_lost.json'), '{}');

    // (a) Nunca lo recogió nadie: se quedó en un buzón sin vigilar.
    writeReceipt(dir, 'tell_lost', receipt({ msgId: 'tell_lost', state: 'filed', at: old, updatedAt: old }));
    // (b) Llegó y está leído; simplemente nadie ha contestado todavía.
    writeReceipt(dir, 'tell_unanswered', receipt({
      msgId: 'tell_unanswered', state: 'read', at: old, updatedAt: old, recipients: ['K9'],
    }));

    const lost = describeReceipt(readReceipt(dir, 'tell_lost'), NOW);
    const unanswered = describeReceipt(readReceipt(dir, 'tell_unanswered'), NOW);
    // Y el tercero: nunca se mandó. Tampoco puede confundirse con los otros dos.
    const never = describeReceipt(readReceipt(dir, 'tell_ghost'), NOW);

    // El barrido devuelve SÓLO el perdido: es el que pide una acción distinta.
    const stranded = sweepReceipts(dir, outDir, NOW).map((r) => r.msgId);

    return ok(
      'lost, unanswered and never-sent are three different, readable facts',
      lost.includes('NOT PICKED UP')
      && unanswered.startsWith('read')
      && !unanswered.includes('NOT PICKED UP')
      && never.includes('never')
      && stranded.length === 1 && stranded[0] === 'tell_lost',
      `lost="${lost}" unanswered="${unanswered}" stranded=${stranded.join(',')}`,
    );
  })),

  test('a receipt still filed inside the grace window is not cried wolf over', () => withDir((dir) => {
    const fresh = NOW - Math.round(PICKUP_GRACE_MS / 2);
    writeReceipt(dir, 'tell_fresh', receipt({ msgId: 'tell_fresh', state: 'filed', at: fresh, updatedAt: fresh }));
    const line = describeReceipt(readReceipt(dir, 'tell_fresh'), NOW);
    // Un aviso que salta siempre deja de ser un aviso: el collector tarda
    // milisegundos, y avisar a los dos segundos enseñaría a ignorarlo.
    return ok(
      'a message filed a moment ago is reported as normal, not as lost',
      !line.includes('NOT PICKED UP') && sweepReceipts(dir, null, NOW).length === 0,
      line,
    );
  })),

  /*
   * El emisor cierra el primer salto él solo.
   *
   * El collector borra el fichero del buzón de salida al recogerlo, así que su
   * ausencia YA es la prueba de que se lo llevaron. Sin esto, un recibo se
   * quedaba en `filed` para siempre mientras nadie lo promoviera, y el aviso
   * saltaba en cada envío hasta volverse ruido. Medido en vivo: tres mensajes
   * entregados y tres avisos de «nunca se recogió».
   */
  test('a message gone from the outbox is understood as picked up, with nobody\'s help', () => withDir((dir) => {
    const old = NOW - 10 * MIN;
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    // El recibo dice `filed`, pero el mensaje ya no está: se lo llevaron.
    writeReceipt(dir, 'tell_taken', receipt({ msgId: 'tell_taken', state: 'filed', at: old, updatedAt: old }));

    const stranded = sweepReceipts(dir, outDir, NOW);
    const after = readReceipt(dir, 'tell_taken');
    return ok(
      'the sender promotes it to picked instead of crying that it was lost',
      stranded.length === 0 && after?.state === 'picked',
      `stranded=${stranded.length} state=${after?.state}`,
    );
  })),

  test('an undelivered message says why, instead of saying nothing', () => withDir((dir) => {
    writeReceipt(dir, 'tell_bad', receipt({
      msgId: 'tell_bad', state: 'undeliverable', detail: 'no encontré a K9', at: NOW, updatedAt: NOW,
    }));
    const line = describeReceipt(readReceipt(dir, 'tell_bad'), NOW);
    return ok(
      'an undeliverable receipt carries the reason to the sender',
      line.includes('NOT DELIVERED') && line.includes('no encontré a K9'),
      line,
    );
  })),

  /* ── 3. la pregunta colgada se ve sola ──────────────────────────── */

  test('a question left hanging shows up in what CAPCOM is owed', async () => {
    const c = ctx({
      agents: [agent({ id: 'a1', callsign: 'K1' }), agent({ id: 'a2', callsign: 'K9' })],
      projects: [project()],
      messages: [
        message({ id: 'msg_old', at: NOW - 40 * MIN }),
        // Recién preguntada: todavía se está contestando, no es deuda.
        message({ id: 'msg_fresh', at: NOW - 30_000 }),
        // Contestada: deja de deberse en cuanto hay respuesta.
        message({ id: 'msg_done', at: NOW - 40 * MIN, answer: 'sí', answeredAt: NOW, answeredBy: 'a2' }),
        // Un notice no es una pregunta y no bloquea a nadie.
        message({ id: 'msg_notice', kind: 'notice', at: NOW - 40 * MIN }),
      ],
    });
    const out = await runTool(c, 'briefing', {});
    const text = out.result;
    return ok(
      'the briefing names the stale ask, and only the stale ask',
      text.includes('PEER QUESTIONS UNANSWERED')
      && text.includes('msg_old') && text.includes('K1 → K9')
      && !text.includes('msg_fresh') && !text.includes('msg_done') && !text.includes('msg_notice'),
      text.split('\n').filter((l) => l.includes('PEER QUESTIONS') || l.includes('msg_')).join(' | '),
    );
  }),

  test('a question whose recipient is gone is called out as unanswerable', async () => {
    const c = ctx({
      agents: [agent({ id: 'a1', callsign: 'K1' }), agent({ id: 'a2', callsign: 'K9', state: 'dead' })],
      projects: [project()],
      messages: [message({ id: 'msg_orphan', at: NOW - 40 * MIN })],
    });
    const out = await runTool(c, 'briefing', {});
    // Esperar una respuesta de un agente muerto es esperar para siempre, y
    // hasta ahora nada lo decía: la pregunta simplemente se quedaba quieta.
    return ok(
      'the briefing says nobody is going to answer that one',
      out.result.includes('msg_orphan') && out.result.includes('RECIPIENT IS GONE'),
      out.result.split('\n').filter((l) => l.includes('msg_orphan')).join(' | '),
    );
  }),

  test('the section is there even when there is nothing owed', async () => {
    const c = ctx({ agents: [agent()], projects: [project()], messages: [] });
    const out = await runTool(c, 'briefing', {});
    // «none» explícito y no una sección ausente: un briefing que a veces trae
    // la sección y a veces no enseña a no buscarla.
    return ok(
      'an empty section still reports itself, so its absence never means "not checked"',
      out.result.includes('PEER QUESTIONS UNANSWERED — answer_agent, or chase whoever owes it: none'),
    );
  }),
];

const suite: TestModule = { suite: 'buzón · raíz, recibo y pregunta colgada', tests };
export default suite;
