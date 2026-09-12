/**
 * AUTOMEJORA: la sección en la que ORCA se mira a sí misma.
 *
 * Todo con reloj falso y sin hub. Lo que se comprueba aquí es lo que hace que
 * la sección sea utilizable y no un generador de ruido:
 *
 *   - una propuesta «medida» sin mediciones no entra, y una «hipótesis» sin
 *     hipótesis tampoco: la marca que el operador usa para decidir tiene que
 *     significar algo
 *   - lo repetido se funde en la que ya había, incluso descartada, y no vuelve
 *     a avisar
 *   - el reloj no gasta un turno de CAPCOM sin motivo, y dice cuál es el que
 *     le falta
 *   - enviar a CAPCOM es irrepetible
 *   - nada de lo que sale hacia la consola o hacia el prompt lleva secretos
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent } from '../src/shared/types.ts';
import type { AutonomyDeps } from '../src/hub/autonomy.ts';
import type { CapcomTimer } from '../src/hub/capcom.ts';
import { AgentLifecycle } from '../src/hub/lifecycle.ts';
import type { JournalStats } from '../src/hub/journal.ts';
import {
  ImproveStore, IMPROVE_DIR, IMPROVE_FILE, IMPROVE_TICK_MS, ORCA_ROOT, USAGE_SAVE_MS, buildDigest, createImprove,
  improveCounts, reviewProject,
} from '../src/hub/improve.ts';
import {
  BUDGET_MAX, BUDGET_MIN, IMPROVE_DEFAULTS, MAX_PROPOSALS, REVIEWER_BUDGET_TOKENS, REVIEWER_IDLE_MS,
  REVIEW_MAX_MS, STOP_ATTEMPTS, activeReview, dueForReview,
  effectiveStatus, emptyState, findDuplicate, improveKey, linkedStatus, normalizeDraft, openProposals,
  proposalHandoff, redact, reviewerBrief, reviewerIds, sortProposals, unseenProposals,
  type ImproveProposal, type ImproveState, type ImproveReview, type ProposalDraft,
} from '../src/shared/improve.ts';
import type { Command, SpawnAck } from '../src/shared/protocol.ts';
import type { Project } from '../src/shared/types.ts';
import { runImproveTool } from '../src/agents/tools-improve.ts';
import type { CeoContext } from '../src/agents/tools.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/* ── fixtures ─────────────────────────────────────────────────────── */

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function draft(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    title: 'Escalations wait too long',
    summary: 'CAPCOM answers late; the queue should surface the oldest first.',
    area: 'usability',
    kind: 'observed',
    evidence: ['avg wait 14m over 31 escalations'],
    ...over,
  };
}

function fakeClock(start = T0) {
  let now = start;
  const queued: { at: number; fn: () => void; every: number; dead: boolean }[] = [];
  return {
    now: () => now,
    setTimer: ((fn, ms) => {
      const e = { at: now + ms, fn, every: 0, dead: false };
      queued.push(e);
      return { cancel: () => { e.dead = true; } } satisfies CapcomTimer;
    }) as AutonomyDeps['setTimer'],
    setInterval: ((fn, ms) => {
      const e = { at: now + ms, fn, every: ms, dead: false };
      queued.push(e);
      return { cancel: () => { e.dead = true; } } satisfies CapcomTimer;
    }) as AutonomyDeps['setInterval'],
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = queued.filter((e) => !e.dead && e.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every > 0) due.at += due.every; else due.dead = true;
        due.fn();
      }
      now = target;
    },
  };
}

function capcom(state: Agent['state'] = 'idle'): Agent {
  return {
    id: 'cap', machineId: 'm1', projectId: 'p1', title: 'capcom', callsign: 'CC',
    runtime: 'claude', state, block: null, origin: 'orca', role: 'capcom',
    parentId: null, depth: 0, childIds: [], mission: null, squad: null, lead: false,
    model: null, tool: null, toolDetail: null, lastPrompt: null, lastSay: null,
    startedAt: T0, updatedAt: T0, uptimeMs: 0,
    metrics: {
      costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0,
      tokensPerSec: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 0,
      toolDurationMs: 0, apiDurationMs: 0, turns: 0,
    },
    background: false, shortId: null,
  } as Agent;
}

function emptyStats(): JournalStats {
  return {
    since: null, until: null, entries: 0, launches: 3,
    byLauncher: { human: 1, capcom: 2, agent: 0 },
    ends: { done: 2, dead: 1 }, doneRate: 2 / 3,
    usage: { tokens: 1_500_000, avgTokens: 500_000, measured: 3 }, duration: { avgMs: 600_000 },
    byProject: [{ project: 'AX', projectId: 'p1', launches: 3, done: 2, dead: 1, doneRate: 2 / 3, totalTokens: 1_500_000, avgTokens: 500_000, avgDurationMs: 600_000, escalations: 1 }],
    escalations: { asked: 4, answeredByCapcom: 2, answeredByHuman: 1, unanswered: 1, avgWaitMs: 840_000 },
    escalatedBriefs: [], rotations: 1, landings: { ok: 2, failed: 0 },
  };
}

/** El proyecto de ORCA, que es donde el revisor corre por defecto. */
function orcaProject(): Project {
  return {
    id: 'p_orca', machineId: 'm1', slug: '-orca', name: 'orca', path: ORCA_ROOT, code: 'OR',
    gitBranch: 'main', gitDirty: false, keyNames: [], sessionIds: [],
    rollup: {} as Project['rollup'],
  };
}

function worker(over: Partial<Agent> = {}): Agent {
  return { ...capcom(), id: 'rev1', callsign: 'R7', role: 'agent', shortId: 'ab12cd34', state: 'working', ...over };
}

interface Rig {
  deps: AutonomyDeps;
  clock: ReturnType<typeof fakeClock>;
  /** Los comandos que salieron de verdad hacia un collector. */
  sent: Command[];
  /** Lo que contesta el spawn. Null = el spawn revienta. */
  ack: SpawnAck | null;
  stopped: string[];
  /** El `stop` revienta: la máquina no está, o el agente ya no responde. */
  stopFails: boolean;
  budgets: { ref: { agentId: string | null; shortId: string | null }; tokens: number }[];
  world: Agent[];
  projects: Project[];
  cap: Agent | null;
  lifecycle: AgentLifecycle;
  dir: string;
  done(): void;
  /** Mete al agente en el mundo y avisa al ciclo de vida, como haría World. */
  arrive(a: Agent): void;
  move(a: Agent, to: Agent['state'], patch?: Partial<Agent>): void;
}

function rig(env: Record<string, string | undefined> = {}): Rig {
  const clock = fakeClock();
  const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
  const lifecycle = new AgentLifecycle();
  const r: Rig = {
    clock, dir, lifecycle,
    sent: [], stopped: [], budgets: [], world: [], projects: [orcaProject()], stopFails: false,
    ack: { agentId: 'rev1', callsign: 'R7', shortId: 'ab12cd34' },
    cap: capcom(),
    done() { rmSync(dir, { recursive: true, force: true }); },
    arrive(a) {
      r.world = [...r.world.filter((x) => x.id !== a.id), a];
      lifecycle.feed({ at: clock.now(), kind: 'agent:new', agentId: a.id, projectId: a.projectId }, a);
    },
    move(a, to, patch = {}) {
      const from = a.state;
      Object.assign(a, patch, { state: to, updatedAt: clock.now() });
      r.world = [...r.world.filter((x) => x.id !== a.id), a];
      lifecycle.feed({ at: clock.now(), kind: 'agent:state', agentId: a.id, projectId: a.projectId, data: { from, to } }, a);
    },
    deps: {
      agents: () => [...(r.cap ? [r.cap] : []), ...r.world],
      agent: (id) => r.world.find((a) => a.id === id),
      projects: () => r.projects,
      project: (id) => r.projects.find((p) => p.id === id),
      missions: () => ({}),
      capcom: () => r.cap,
      sayToCapcom: () => 'delivered',
      // El único camino de salida: si esto no se llama, no se lanzó nada.
      dispatch: async (cmd) => {
        r.sent.push(cmd);
        if (cmd.k === 'spawn' && r.ack === null) throw new Error('no machine took the spawn');
        return cmd.k === 'spawn' ? r.ack : {};
      },
      stopAgent: async (id) => {
        r.stopped.push(id);
        if (r.stopFails) throw new Error('machine offline');
        return {};
      },
      dir, env, now: clock.now,
      setTimer: clock.setTimer, setInterval: clock.setInterval,
      log: () => {}, note: () => {},
      lifecycle,
    },
  };
  return r;
}

/** El spawn que salió, si salió. */
function spawnOf(r: Rig): Extract<Command, { k: 'spawn' }> | null {
  return (r.sent.find((c) => c.k === 'spawn') ?? null) as Extract<Command, { k: 'spawn' }> | null;
}

function improveApi(r: Rig) {
  return createImprove(r.deps, {
    journal: { stats: () => emptyStats() },
    fleet: () => ({ agents: 4, blocked: 1, missionsOpen: 2, missionsOwed: 1 }),
    budget: (ref, tokens) => { r.budgets.push({ ref, tokens }); },
  });
}

/** Una revisión de mentira, para las pruebas de `dueForReview`. */
function review(over: Partial<ImproveReview> = {}): ImproveReview {
  // Cerrada por defecto (`endedAt`): una revisión sin cerrar ocupa el sitio, y
  // casi todas estas pruebas hablan de las que ya pasaron.
  return { id: 'rev_x', at: T0, endedAt: T0, trigger: 'auto', reason: '', status: 'reported', filed: 0, merged: 0, ...over };
}

/**
 * Deja correr las promesas pendientes.
 *
 * El tic lanza el spawn sin esperarlo (`void run('auto')`), que es lo correcto
 * —un reloj no se bloquea— pero significa que después de mover el reloj falso
 * hay una promesa en la cola de microtareas. Sin esto la prueba miraría el
 * tablero antes de que el ack hubiera vuelto.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Suficiente señal para que el reloj no se pare por eso. */
function feed(api: { record(n: string): void }, n = IMPROVE_DEFAULTS.minSignal): void {
  for (let i = 0; i < n; i++) api.record('ui:cmd');
}

function ctxWith(store: ImproveStore): CeoContext {
  const improve: NonNullable<CeoContext['improve']> = {
    state: () => store.state(),
    file: (reviewId, drafts) => store.file(reviewId, drafts),
    note: (id, role, text) => store.note(id, role, text),
  };
  return { improve } as unknown as CeoContext;
}

/* ── tests ────────────────────────────────────────────────────────── */

const tests = [
  test('a "measured" proposal without measurements is refused, and so is a hypothesis without one', () => {
    const noEvidence = normalizeDraft(draft({ evidence: [] }));
    const noHypothesis = normalizeDraft(draft({ kind: 'hypothesis', evidence: [], hypothesis: '' }));
    const goodHypothesis = normalizeDraft(draft({ kind: 'hypothesis', evidence: [], hypothesis: 'the field is the bottleneck' }));
    const badArea = normalizeDraft(draft({ area: 'vibes' }));
    return ok('the mark the operator decides by cannot be empty',
      !noEvidence.ok && noEvidence.error.includes('kind="hypothesis"')
      && !noHypothesis.ok && noHypothesis.error.includes('hypothesis')
      && goodHypothesis.ok && !badArea.ok,
      `${noEvidence.ok ? '' : noEvidence.error}`);
  }),

  test('an invented impact is not stored, and a graded one is', () => {
    const bare = normalizeDraft(draft());
    const graded = normalizeDraft(draft({ impact: 'high', effort: 'nope' }));
    return ok('impact/effort are optional and validated',
      bare.ok && bare.value.impact === undefined
      && graded.ok && graded.value.impact === 'high' && graded.value.effort === undefined);
  }),

  test('a credential inside a proposal never reaches disk', () => {
    const parsed = normalizeDraft(draft({ summary: 'use token=abcdef1234567890 for the hub', evidence: ['Bearer sk-abcdefghijklmnopqrst calls'] }));
    const hit = parsed.ok && !parsed.value.summary.includes('abcdef1234567890') && !parsed.value.evidence[0]!.includes('sk-abcdefghij');
    return ok('redact runs before anything is stored', hit && redact('sk-abcdefghijklmnop') === '[redacted]',
      parsed.ok ? parsed.value.summary : 'rejected');
  }),

  test('the same idea twice is one row, one notification, and it survives a dismissal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      const first = store.file('rev_1', [draft()]);
      const id = first.proposals[0]!.id;
      store.markSeen();
      store.act(id, { act: 'dismiss' });
      // Otra revisión llega a lo mismo con otra clave y otra puntuación.
      const again = store.file('rev_2', [draft({ key: 'something-else', title: 'Escalations   wait  too long!' })]);
      const p = store.get(id);
      return ok('merged into the dismissed one instead of coming back',
        first.filed === 1 && again.filed === 0 && again.merged === 1
        && p.status === 'dismissed' && p.raised === 2 && p.seenAt !== undefined
        && Object.keys(store.state().proposals).length === 1,
        `filed=${again.filed} merged=${again.merged} status=${p.status} raised=${p.raised}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a title says which idea it is even when the words move around', () => eq(
    'improveKey normalises', improveKey('  ESCALATIONS: wait — too  long!! '), improveKey('escalations-wait-too-long'),
  )),

  test('the board survives a restart, and a snooze that ran out is open again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      let now = T0;
      const store = new ImproveStore(dir, () => now);
      const id = store.file('rev_1', [draft()]).proposals[0]!.id;
      store.act(id, { act: 'snooze', untilMs: T0 + 86_400_000 });

      const reopened = new ImproveStore(dir, () => now);
      const before = effectiveStatus(reopened.get(id), now);
      now = T0 + 2 * 86_400_000;
      const after = effectiveStatus(reopened.get(id), now);
      const onDisk = JSON.parse(readFileSync(join(dir, IMPROVE_DIR, IMPROVE_FILE), 'utf8')) as ImproveState;
      return ok('snoozed → open by the clock alone, and nothing was lost',
        before === 'snoozed' && after === 'open'
        && onDisk.proposals[id]!.title === draft().title
        && openProposals(reopened.state(), now).length === 1,
        `${before} → ${after}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('one notification per proposal: seen once, never new again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      store.file('rev_1', [draft()]);
      const before = unseenProposals(store.state(), T0).length;
      const marked = store.markSeen();
      // La misma idea vuelve a salir en otra revisión: sube `raised`, no avisa.
      store.file('rev_2', [draft()]);
      const after = unseenProposals(store.state(), T0).length;
      return ok('re-raising does not re-notify', before === 1 && marked === 1 && after === 0, `${before} → ${after}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a proposal becomes a mission exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      const id = store.file('rev_1', [draft()]).proposals[0]!.id;
      const sent = store.act(id, { act: 'sent', missionId: 'mission_a' });
      let refused = false;
      try { store.act(id, { act: 'sent', missionId: 'mission_b' }); } catch { refused = true; }
      let reopenRefused = false;
      try { store.act(id, { act: 'reopen' }); } catch { reopenRefused = true; }
      return ok('the second SEND is refused and the link stands',
        sent.missionId === 'mission_a' && refused && reopenRefused && store.get(id).missionId === 'mission_a');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the operator answer lands in the thread and travels with the handoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      const id = store.file('rev_1', [draft({ question: 'Should the queue sort by age?' })]).proposals[0]!.id;
      store.act(id, { act: 'reply', text: 'yes, oldest first' });
      store.note(id, 'capcom', 'understood, filing a revision');
      const handoff = proposalHandoff(store.get(id));
      return ok('conversation preserved end to end',
        store.get(id).notes.length === 2
        && handoff.includes('yes, oldest first') && handoff.includes('understood, filing')
        && handoff.includes('avg wait 14m') && handoff.includes('The operator approved this'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the clock says which condition is missing, one at a time', () => {
    const now = T0;
    const alive = { capcomAlive: true, capcomBusy: false };
    const base = emptyState(now);
    const paused = dueForReview({ ...base, config: { ...base.config, paused: true } }, now, alive);
    const quiet = dueForReview(base, now, alive);
    const loud = { ...base, signal: { since: now, counts: { 'ui:cmd': 99 }, total: 99 } };
    const busy = dueForReview(loud, now, { capcomAlive: true, capcomBusy: true });
    const go = dueForReview(loud, now, alive);
    const soon = dueForReview({ ...loud, reviews: [review({ at: now - 60_000, status: 'reported' })] }, now, alive);
    const working = dueForReview({ ...loud, reviews: [{ ...review({ at: now - 60_000, status: 'running', callsign: 'R7' }), endedAt: undefined }] }, now, alive);
    return ok('every refusal names its reason',
      paused.reason.includes('PAUSED') && !paused.due
      && quiet.reason.includes('SIGNAL') && !quiet.due
      && busy.reason.includes('MID-TURN') && !busy.due
      && soon.reason.startsWith('NEXT IN') && !soon.due
      && working.reason.includes('R7') && working.reason.includes('WORKING') && !working.due
      && go.due,
      `${quiet.reason} / ${working.reason}`);
  }),

  test('a reviewer past its wall clock still blocks: that hole is closed', () => {
    const now = T0;
    const stale = {
      ...emptyState(now),
      signal: { since: now, counts: {}, total: 999 },
      reviews: [{ ...review({ at: now - REVIEW_MAX_MS - 1, status: 'running' }), endedAt: undefined }],
    };
    const v = dueForReview(stale, now, { capcomAlive: true, capcomBusy: false });
    return ok('an old review is not a free slot',
      // Antes `activeReview` la apartaba pasados 45 minutos, y ahí es donde se
      // colaba un segundo revisor encima de uno que no se moría.
      activeReview(stale, now) !== null && !v.due,
      v.reason);
  }),

  test('the daily ceiling holds even when everything else says go', () => {
    const now = T0;
    const reviews = Array.from({ length: IMPROVE_DEFAULTS.perDay }, (_, i) =>
      review({ at: now - (i + 1) * 3_600_000, status: 'reported' }));
    const state = { ...emptyState(now), reviews, signal: { since: now, counts: {}, total: 999 }, config: { ...IMPROVE_DEFAULTS, everyMin: 5 } };
    const v = dueForReview(state, now, { capcomAlive: true, capcomBusy: false });
    return ok('at the ceiling, and it says so', !v.due && v.reason.includes('DAILY CEILING'), v.reason);
  }),

  /* ── el agente revisor ────────────────────────────────────────── */

  test('a review is a real spawn: no parent, no worktree, review privileges, and a budget', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      feed(api);
      r.clock.advance(IMPROVE_TICK_MS * 3);
      await settle();
      const spawn = spawnOf(r);
      const rev = api.store.state().reviews[0]!;
      return ok('the command that went out is the one a reviewer needs',
        !!spawn && spawn.projectId === 'p_orca' && spawn.review === true
        && spawn.parentId === null && spawn.worktree === false && spawn.background === true
        && spawn.mission.includes(rev.id)
        && spawn.prompt.includes('[ORCA SELF-REVIEW') && spawn.prompt.includes('orca-improve report')
        && spawn.prompt.includes('You do not implement anything')
        && rev.status === 'running' && rev.agentId === 'rev1' && rev.callsign === 'R7'
        && r.budgets.length === 1 && r.budgets[0]!.tokens === REVIEWER_BUDGET_TOKENS
        && r.budgets[0]!.ref.agentId === 'rev1',
        `${spawn?.mission} · budget ${r.budgets[0]?.tokens}`);
    } finally { api.stop(); r.done(); }
  }),

  test('one reviewer at a time, however much signal arrives', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      feed(api);
      r.clock.advance(IMPROVE_TICK_MS * 2);
      await settle();
      const first = r.sent.length;
      r.arrive(worker());
      feed(api, 5_000);
      r.clock.advance(IMPROVE_TICK_MS * 20);
      await settle();
      const manual = await api.run('manual');
      return ok('the slot is taken and says by whom',
        first === 1 && r.sent.length === 1 && !manual.ok && manual.reason.includes('R7'),
        manual.reason);
    } finally { api.stop(); r.done(); }
  }),

  test('a spawn that fails frees the slot instead of jamming the section', async () => {
    const r = rig();
    r.ack = null;
    const api = improveApi(r);
    try {
      feed(api);
      const first = await api.run('manual');
      const failed = api.store.state().reviews[0]!;
      // El hueco vuelve a estar libre en el acto: nada que esperar.
      r.ack = { agentId: 'rev1', callsign: 'R7', shortId: 'ab12cd34' };
      const second = await api.run('manual');
      return ok('failed, said why, and the next one goes',
        !first.ok && first.reason.includes('could not launch')
        && failed.status === 'failed' && (failed.note ?? '').includes('no machine took the spawn')
        && second.ok,
        failed.note);
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer that finishes without filing is not a completed review', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.move(a, 'done', { metrics: { ...a.metrics, costUSD: 0.42, inputTokens: 90_000, outputTokens: 10_000 } });
      const rev = api.store.state().reviews[0]!;
      return ok('ended, with what it cost, and never "reported"',
        rev.status === 'ended' && (rev.note ?? '').includes('without filing')
        && rev.costUSD === 0.42 && rev.tokens === 100_000
        && activeReview(api.store.state(), r.clock.now()) === null,
        `${rev.status} · ${rev.note}`);
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer that dies is a failure, and a reviewer that filed stays reported', async () => {
    const dead = rig();
    const deadApi = improveApi(dead);
    let deadStatus = '';
    try {
      await deadApi.run('manual');
      const a = worker();
      dead.arrive(a);
      dead.move(a, 'dead');
      deadStatus = deadApi.store.state().reviews[0]!.status;
    } finally { deadApi.stop(); dead.done(); }

    const okRig = rig();
    const api = improveApi(okRig);
    try {
      await api.run('manual');
      const a = worker();
      okRig.arrive(a);
      api.report({ agentId: 'rev1', reviewId: null, proposals: [draft()] });
      okRig.move(a, 'done');
      const rev = api.store.state().reviews[0]!;
      return ok('the two endings are told apart',
        deadStatus === 'failed' && rev.status === 'reported' && rev.filed === 1 && rev.endedAt !== undefined,
        `${deadStatus} / ${rev.status}`);
    } finally { api.stop(); okRig.done(); }
  }),

  test('what the reviewer files carries its name, and a stranger cannot file at all', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      r.arrive(worker());
      const out = api.report({ agentId: 'rev1', reviewId: null, proposals: [draft()] });
      const p = out.proposals[0]!;
      let refused = '';
      try { api.report({ agentId: 'someone-else', reviewId: null, proposals: [draft({ key: 'other' })] }); }
      catch (err) { refused = err instanceof Error ? err.message : String(err); }
      return ok('the proposal knows who wrote it, and only that agent can write',
        p.agentId === 'rev1' && p.callsign === 'R7' && out.filed === 1
        && refused.includes('belongs to'),
        refused);
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer that filed and went quiet is finished, not left running forever', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      api.report({ agentId: 'rev1', reviewId: null, proposals: [draft()] });
      // Un CLI no termina solo: acaba su turno y se queda `idle`.
      r.move(a, 'idle');
      const stillThinking = activeReview(api.store.state(), r.clock.now()) !== null;
      r.clock.advance(REVIEWER_IDLE_MS + IMPROVE_TICK_MS);
      const settled = api.store.state().reviews[0]!;
      // Decidido y parado — pero el hueco sigue ocupado hasta confirmarlo.
      const blocked = await api.run('manual');
      r.move(a, 'done');
      const closed = api.store.state().reviews[0]!;
      return ok('held while it might be thinking, then decided, stopped, and freed on confirmation',
        stillThinking && settled.status === 'reported' && settled.outcomeAt !== undefined
        && settled.endedAt === undefined && r.stopped.includes('rev1') && !blocked.ok
        && closed.endedAt !== undefined
        && activeReview(api.store.state(), r.clock.now()) === null,
        `${closed.status} · stopped=${r.stopped.join(',')}`);
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer that goes quiet WITHOUT filing is ended, and never called a review', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.move(a, 'idle');
      r.clock.advance(REVIEWER_IDLE_MS + IMPROVE_TICK_MS);
      r.move(a, 'done');
      const rev = api.store.state().reviews[0]!;
      return ok('ended, stopped, and honest about what it produced',
        rev.status === 'ended' && rev.filed === 0 && r.stopped.includes('rev1')
        && rev.endedAt !== undefined, rev.status);
    } finally { api.stop(); r.done(); }
  }),

  test('the callsign is filled from the fleet when the ack did not carry it', async () => {
    const r = rig();
    r.ack = { agentId: 'rev1', callsign: null, shortId: 'ab12cd34' };
    const api = improveApi(r);
    try {
      await api.run('manual');
      const before = api.store.state().reviews[0]!.callsign;
      r.arrive(worker({ callsign: 'QW' }));
      r.clock.advance(IMPROVE_TICK_MS);
      const after = api.store.state().reviews[0]!.callsign;
      return ok('a review is never nameless in the history',
        before === undefined && after === 'QW', `${before} → ${after}`);
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer that hangs is expired and stopped, and freed when it is gone', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.clock.advance(REVIEW_MAX_MS + IMPROVE_TICK_MS);
      const rev = api.store.state().reviews[0]!;
      const blocked = await api.run('manual');
      r.move(a, 'dead');
      const next = await api.run('manual');
      return ok('expired, stopped, blocked while alive, and free once confirmed',
        rev.status === 'expired' && rev.endedAt === undefined && r.stopped.includes('rev1')
        && !blocked.ok && next.ok,
        `${rev.status} · stopped=${r.stopped.join(',')}`);
    } finally { api.stop(); r.done(); }
  }),

  test('cancelling asks for a stop and HOLDS the slot until the fleet confirms', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      const out = await api.cancel();
      const held = api.store.state().reviews[0]!;
      const second = await api.run('manual');
      const stillOne = r.sent.filter((c) => c.k === 'spawn').length;
      r.move(a, 'dead');
      const closed = api.store.state().reviews[0]!;
      const after = await api.run('manual');
      return ok('one reviewer, even while one is dying',
        out.ok && r.stopped.includes('rev1')
        && held.status === 'cancelled' && held.outcomeAt !== undefined && held.endedAt === undefined
        && !second.ok && stillOne === 1
        && closed.endedAt !== undefined && closed.status === 'cancelled' && after.ok,
        `${second.reason} · closed=${closed.status}`);
    } finally { api.stop(); r.done(); }
  }),

  /*
   * La garantía que importa, y la que estaba rota: mientras el revisor pueda
   * seguir vivo, NADA abre la puerta al siguiente. Ni el reloj de pared, ni el
   * techo, ni una parada que falló, ni agotar los reintentos.
   */
  test('a stop that keeps failing NEVER hands the slot to a second reviewer', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.stopFails = true;
      const out = await api.cancel();

      // Media hora más allá de cualquier gracia, con el agente vivo y todos
      // los `stop` fallando, probando a mano en cada minuto.
      const launched: boolean[] = [];
      for (let i = 0; i < 30; i++) {
        r.clock.advance(60_000);
        launched.push((await api.run('manual')).ok);
      }
      const held = api.store.state().reviews[0]!;
      const spawns = r.sent.filter((c) => c.k === 'spawn').length;
      const verdict = api.verdict();

      // Y cuando por fin se confirma que se fue, se recupera sola.
      r.move(a, 'dead');
      const closed = api.store.state().reviews[0]!;
      r.stopFails = false;
      const after = await api.run('manual');

      return ok('denied for half an hour, then recovered on confirmation',
        out.holding === true
        && launched.every((okd) => okd === false)
        && spawns === 1
        && held.endedAt === undefined && held.status === 'cancelled'
        // Los reintentos están acotados: no se manda un stop por segundo.
        && (held.stopAttempts ?? 0) === STOP_ATTEMPTS
        && !verdict.due && verdict.reason.includes('WAITING FOR THE FLEET')
        && closed.endedAt !== undefined && after.ok
        && r.sent.filter((c) => c.k === 'spawn').length === 2,
        `${spawns} spawn(s) · ${held.stopAttempts} stops · ${verdict.reason}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the wall clock decides the outcome but does not open the door', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.stopFails = true;
      r.clock.advance(REVIEW_MAX_MS * 2);
      const held = api.store.state().reviews[0]!;
      const manual = await api.run('manual');
      const spawns = r.sent.filter((c) => c.k === 'spawn').length;
      r.move(a, 'done');
      const closed = api.store.state().reviews[0]!;
      const after = await api.run('manual');
      return ok('expired, still blocking, and freed only by confirmation',
        held.status === 'expired' && held.outcomeAt !== undefined && held.endedAt === undefined
        && !manual.ok && spawns === 1
        && closed.endedAt !== undefined && closed.status === 'expired' && after.ok,
        `${manual.reason} · ${closed.note}`);
    } finally { api.stop(); r.done(); }
  }),

  test('over budget decides the outcome but does not open the door either', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      r.stopFails = true;
      r.move(a, 'thinking', {
        metrics: { ...a.metrics, inputTokens: 300_000, outputTokens: 40_000, cacheReadTokens: 200_000, costUSD: 0.9 },
      });
      const held = api.store.state().reviews[0]!;
      const manual = await api.run('manual');
      r.clock.advance(REVIEW_MAX_MS);
      const stillHeld = api.store.state().reviews[0]!.endedAt === undefined;
      r.move(a, 'dead');
      const closed = api.store.state().reviews[0]!;
      return ok('over budget, held, and the figures survive the close',
        held.status === 'overbudget' && held.endedAt === undefined
        && (held.note ?? '').includes('540k of a 400k ceiling')
        && !manual.ok && stillHeld
        && closed.endedAt !== undefined && closed.status === 'overbudget' && closed.tokens === 540_000,
        `${manual.reason} · ${closed.note}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the ceiling does not count cache reads: AJ\'s first minute no longer stops it', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      // AJ a los 46 s (rev_mtw8cgp3dupemnnh), con la lectura de caché inflada
      // a lo que el collector llegó a ver: con la regla vieja eran 451k de 400k.
      r.move(a, 'thinking', {
        metrics: { ...a.metrics, inputTokens: 12, outputTokens: 2_657, cacheReadTokens: 445_426, cacheWriteTokens: 111_339, costUSD: 1.29 },
      });
      const alive = api.store.state().reviews[0]!;
      // Lo que entra nuevo sí cuenta: un revisor que se desboca se sigue parando.
      r.move(a, 'working', {
        metrics: { ...a.metrics, inputTokens: 40, outputTokens: 60_000, cacheReadTokens: 4_000_000, cacheWriteTokens: 360_000 },
      });
      const stopped = api.store.state().reviews[0]!;
      return ok('cache reads alone never trip it; new tokens still do',
        alive.outcomeAt === undefined && r.stopped.length === 0
        && stopped.status === 'overbudget' && stopped.tokens === 420_040
        && (stopped.note ?? '').includes('420k of a 400k ceiling'),
        `${alive.status} → ${stopped.status} · ${stopped.note}`);
    } finally { api.stop(); r.done(); }
  }),

  test('cancelled before its agent exists closes at once: there is nobody to wait for', async () => {
    const r = rig();
    r.ack = { agentId: null, callsign: null, shortId: null };
    const api = improveApi(r);
    try {
      await api.run('manual');
      const out = await api.cancel();
      const rev = api.store.state().reviews[0]!;
      const next = await api.run('manual');
      return ok('no agent, no wait',
        out.ok && rev.endedAt !== undefined && rev.status === 'cancelled' && next.ok, out.reason);
    } finally { api.stop(); r.done(); }
  }),

  test('a hub restart does not leave a review running forever', async () => {
    const r = rig();
    const first = improveApi(r);
    try {
      await first.run('manual');
      r.arrive(worker());
    } finally { first.stop(); }
    // El hub se cae con la revisión en marcha y vuelve sin ese agente.
    r.world = [];
    const second = improveApi(r);
    try {
      const rev = second.store.state().reviews[0]!;
      const next = await second.run('manual');
      return ok('swept on startup, and the section is usable again',
        rev.status === 'failed' && (rev.note ?? '').includes('no longer on the fleet') && next.ok,
        rev.note);
    } finally { second.stop(); r.done(); }
  }),

  test('the session id that the ack never saw is bound when the agent appears', async () => {
    const r = rig();
    r.ack = { agentId: null, callsign: null, shortId: 'ab12cd34' };
    const api = improveApi(r);
    try {
      await api.run('manual');
      const before = api.store.state().reviews[0]!.agentId;
      r.arrive(worker({ id: 'late-id', shortId: 'ab12cd34', callsign: 'R9' }));
      const after = api.store.state().reviews[0]!;
      return ok('bound by short id, and the console can reach it',
        before === undefined && after.agentId === 'late-id' && after.callsign === 'R9'
        && reviewerIds(api.store.state()).has('late-id'),
        `${before} → ${after.agentId}`);
    } finally { api.stop(); r.done(); }
  }),

  test('with nowhere to review, nothing is launched and the panel is told why', async () => {
    const r = rig();
    r.projects = [];
    const api = improveApi(r);
    try {
      feed(api);
      r.clock.advance(IMPROVE_TICK_MS * 5);
      await settle();
      const manual = await api.run('manual');
      return ok('no project, no spawn, and a reason a person can act on',
        r.sent.length === 0 && !manual.ok && manual.reason.includes('not a project on this fleet')
        && api.verdict().reason.includes('NOT A PROJECT'),
        api.verdict().reason);
    } finally { api.stop(); r.done(); }
  }),

  test('the project is ORCA\'s own repo, or the one the operator named', () => {
    const orca = orcaProject();
    const other: Project = { ...orca, id: 'p_other', name: 'axolots', code: 'AX', path: '/tmp/axolots' };
    return ok('found by path, id, code and name',
      reviewProject([other, orca], '')?.id === 'p_orca'
      && reviewProject([other, orca], 'AX')?.id === 'p_other'
      && reviewProject([other, orca], 'p_other')?.id === 'p_other'
      && reviewProject([other], '') === null);
  }),

  test('ORCA_IMPROVE=0 is a real off switch, manual run included', async () => {
    const r = rig({ ORCA_IMPROVE: '0' });
    const api = improveApi(r);
    try {
      feed(api);
      r.clock.advance(IMPROVE_DEFAULTS.everyMin * 60_000 * 2);
      await settle();
      const manual = await api.run('manual');
      return ok('nothing runs and the panel is told why',
        r.sent.length === 0 && !manual.ok && api.verdict().reason.includes('ORCA_IMPROVE=0'));
    } finally { api.stop(); r.done(); }
  }),

  /* ── con qué se lanza ─────────────────────────────────────────── */

  test('the chosen runtime and model reach the spawn, and are sealed on the review', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'codex', model: 'gpt-5-codex' });
      const out = await api.run('manual');
      const spawn = spawnOf(r)!;
      const rev = api.store.state().reviews[0]!;
      return ok('the payload says what was chosen, and the history keeps it',
        out.ok && spawn.runtime === 'codex' && spawn.model === 'gpt-5-codex'
        && rev.runtime === 'codex' && rev.model === 'gpt-5-codex',
        `${spawn.runtime}/${spawn.model}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the automatic clock launches with the same choice as a manual run', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      feed(api);
      r.clock.advance(IMPROVE_TICK_MS * 3);
      await settle();
      const spawn = spawnOf(r)!;
      return ok('one path, one choice', spawn.runtime === 'claude' && spawn.model === 'opus',
        `${spawn.runtime}/${spawn.model}`);
    } finally { api.stop(); r.done(); }
  }),

  test('with nothing chosen it follows the environment, exactly as before', async () => {
    const r = rig({ ORCA_IMPROVE_RUNTIME: 'codex', ORCA_IMPROVE_MODEL: 'gpt-5' });
    const api = improveApi(r);
    try {
      const before = api.choice();
      await api.run('manual');
      const spawn = spawnOf(r)!;
      return ok('an install that had the env vars set does not change on upgrade',
        api.store.state().runtime === null && api.store.state().model === null
        && before.runtime === 'codex' && before.model === 'gpt-5'
        && before.from.runtime === 'environment' && before.from.model === 'environment'
        && spawn.runtime === 'codex' && spawn.model === 'gpt-5',
        `${before.runtime}/${before.model} from the ${before.from.runtime}`);
    } finally { api.stop(); r.done(); }
  }),

  test('what the operator chose beats the environment, and says so', () => {
    const r = rig({ ORCA_IMPROVE_RUNTIME: 'codex', ORCA_IMPROVE_MODEL: 'gpt-5' });
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      const c = api.choice();
      return ok('the panel can say where each half comes from',
        c.runtime === 'claude' && c.model === 'opus'
        && c.from.runtime === 'operator' && c.from.model === 'operator');
    } finally { api.stop(); r.done(); }
  }),

  test('choosing nothing at all means the CLI decides the model', () => {
    const r = rig();
    const api = improveApi(r);
    try {
      const c = api.choice();
      return ok('no invented default: an empty model is the CLI\'s own',
        c.runtime === 'claude' && c.model === null && c.from.model === 'cli');
    } finally { api.stop(); r.done(); }
  }),

  test('a runtime ORCA cannot launch is refused with its reason, and nothing changes', () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      let why = '';
      try { api.store.setConfig({ runtime: 'gemini' }); } catch (err) { why = err instanceof Error ? err.message : String(err); }
      let badModel = '';
      try { api.store.setConfig({ model: 'opus; rm -rf /' }); } catch (err) { badModel = err instanceof Error ? err.message : String(err); }
      const st = api.store.state();
      return ok('refused, not clamped: no runtime is "close enough"',
        why.includes('claude, codex') && badModel.includes('letters, digits')
        && st.runtime === 'claude' && st.model === 'opus',
        `${why} · ${badModel}`);
    } finally { api.stop(); r.done(); }
  }),

  test('an empty choice clears it back to inherited', () => {
    const r = rig({ ORCA_IMPROVE_RUNTIME: 'codex' });
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      const set = api.store.setConfig({ runtime: null, model: '' as unknown as string });
      return ok('there is a way back to the default',
        set.runtime === null && set.model === null && api.choice().runtime === 'codex');
    } finally { api.stop(); r.done(); }
  }),

  test('changing runtime alone clears the model, and the spawn proves it', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      // Sólo el runtime. Nadie manda `model: null`: si la limpieza dependiera
      // del panel, esta pareja imposible llegaría al lanzamiento.
      const set = api.store.setConfig({ runtime: 'codex' });
      await api.run('manual');
      const spawn = spawnOf(r)!;
      return ok('no codex/opus: an alias of one CLI is not a model of the other',
        set.runtime === 'codex' && set.model === null
        && api.store.state().model === null
        && spawn.runtime === 'codex' && spawn.model === undefined,
        `${set.runtime}/${String(set.model)} · spawn ${spawn.runtime}/${String(spawn.model)}`);
    } finally { api.stop(); r.done(); }
  }),

  test('a runtime and a model chosen in the same breath both survive', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      const set = api.store.setConfig({ runtime: 'codex', model: 'gpt-5-codex' });
      await api.run('manual');
      const spawn = spawnOf(r)!;
      return ok('the explicit model wins: it is one decision, not two',
        set.runtime === 'codex' && set.model === 'gpt-5-codex'
        && spawn.runtime === 'codex' && spawn.model === 'gpt-5-codex',
        `${set.runtime}/${String(set.model)}`);
    } finally { api.stop(); r.done(); }
  }),

  test('re-choosing the runtime already in force keeps the model', () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      const same = api.store.setConfig({ runtime: 'claude' });
      return ok('nothing changed, so nothing is thrown away',
        same.runtime === 'claude' && same.model === 'opus', String(same.model));
    } finally { api.stop(); r.done(); }
  }),

  test('going back to inherited clears the model only if the effective runtime moves', () => {
    const stays = rig({ ORCA_IMPROVE_RUNTIME: 'claude' });
    const moves = rig({ ORCA_IMPROVE_RUNTIME: 'codex' });
    const a = improveApi(stays);
    const b = improveApi(moves);
    try {
      a.store.setConfig({ runtime: 'claude', model: 'opus' });
      const kept = a.store.setConfig({ runtime: null });
      b.store.setConfig({ runtime: 'claude', model: 'opus' });
      const dropped = b.store.setConfig({ runtime: null });
      return ok('inheriting the same CLI is not a change; inheriting another one is',
        kept.model === 'opus' && a.choice().runtime === 'claude'
        && dropped.model === null && b.choice().runtime === 'codex' && b.choice().model === null,
        `stays ${String(kept.model)} · moves ${String(dropped.model)}`);
    } finally { a.stop(); stays.done(); b.stop(); moves.done(); }
  }),

  test('the environment model is not inherited under another CLI, in either direction', async () => {
    const toCodex = rig({ ORCA_IMPROVE_RUNTIME: 'claude', ORCA_IMPROVE_MODEL: 'opus' });
    const toClaude = rig({ ORCA_IMPROVE_RUNTIME: 'codex', ORCA_IMPROVE_MODEL: 'gpt-5' });
    const a = improveApi(toCodex);
    const b = improveApi(toClaude);
    try {
      a.store.setConfig({ runtime: 'codex' });
      b.store.setConfig({ runtime: 'claude' });
      await a.run('manual');
      await b.run('manual');
      const sa = spawnOf(toCodex)!;
      const sb = spawnOf(toClaude)!;
      const ca = a.choice();
      const cb = b.choice();
      return ok('ORCA_IMPROVE_MODEL belongs to ORCA_IMPROVE_RUNTIME, not to every CLI',
        ca.runtime === 'codex' && ca.model === null && ca.from.model === 'cli'
        && cb.runtime === 'claude' && cb.model === null && cb.from.model === 'cli'
        && sa.runtime === 'codex' && sa.model === undefined
        && sb.runtime === 'claude' && sb.model === undefined,
        `${ca.runtime}/${String(ca.model)} · ${cb.runtime}/${String(cb.model)}`);
    } finally { a.stop(); toCodex.done(); b.stop(); toClaude.done(); }
  }),

  test('letting the runtime go back to inherited brings the environment model back', () => {
    const r = rig({ ORCA_IMPROVE_RUNTIME: 'claude', ORCA_IMPROVE_MODEL: 'opus' });
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'codex' });
      const away = api.choice();
      api.store.setConfig({ runtime: null });
      const back = api.choice();
      return ok('the environment is not lost, it is just not applicable meanwhile',
        away.model === null && back.runtime === 'claude' && back.model === 'opus'
        && back.from.model === 'environment',
        `${String(away.model)} → ${String(back.model)}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the automatic clock inherits no foreign model either', async () => {
    const r = rig({ ORCA_IMPROVE_RUNTIME: 'claude', ORCA_IMPROVE_MODEL: 'opus' });
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'codex' });
      feed(api);
      r.clock.advance(IMPROVE_TICK_MS * 3);
      await settle();
      const spawn = spawnOf(r)!;
      const rev = api.store.state().reviews[0]!;
      return ok('the clock and the button build the same payload',
        spawn.runtime === 'codex' && spawn.model === undefined
        && rev.runtime === 'codex' && rev.model === undefined,
        `${spawn.runtime}/${String(spawn.model)}`);
    } finally { api.stop(); r.done(); }
  }),

  test('changing the model mid-flight does not touch the review already running', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ runtime: 'claude', model: 'opus' });
      await api.run('manual');
      r.arrive(worker());
      api.store.setConfig({ model: 'haiku' });
      const rev = api.store.state().reviews[0]!;
      return ok('the seal holds: a setting is for the NEXT one',
        rev.model === 'opus' && api.store.state().model === 'haiku', `${rev.model} vs ${api.store.state().model}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the budget is clamped by the server, both ways, whatever the panel sends', () => {
    const r = rig();
    const api = improveApi(r);
    try {
      const tiny = api.store.setConfig({ budgetTokens: 1 });
      const huge = api.store.setConfig({ budgetTokens: 999_000_000 });
      const exact = api.store.setConfig({ budgetTokens: 650_000 });
      const junk = api.store.setConfig({ budgetTokens: Number.NaN });
      return ok('a typed number never becomes a ceiling nobody meant',
        tiny.budgetTokens === BUDGET_MIN && huge.budgetTokens === BUDGET_MAX
        && exact.budgetTokens === 650_000 && junk.budgetTokens === 650_000,
        `${tiny.budgetTokens} · ${huge.budgetTokens} · ${exact.budgetTokens}`);
    } finally { api.stop(); r.done(); }
  }),

  test('the budget that a review was launched with is the one it is judged by', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      api.store.setConfig({ budgetTokens: 100_000 });
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      // Subir el techo DESPUÉS no salva a la revisión que ya iba con el viejo.
      api.store.setConfig({ budgetTokens: 2_000_000 });
      r.move(a, 'thinking', { metrics: { ...a.metrics, inputTokens: 120_000, outputTokens: 5_000, cacheReadTokens: 0 } });
      const rev = api.store.state().reviews[0]!;
      return ok('the ceiling is sealed with the review, like the model',
        rev.budgetTokens === 100_000 && rev.status === 'overbudget'
        && (rev.note ?? '').includes('of a 100k ceiling'),
        rev.note);
    } finally { api.stop(); r.done(); }
  }),

  test('choice and budget survive a restart, and an old file keeps its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const first = new ImproveStore(dir, () => T0);
      first.setConfig({ runtime: 'codex', model: 'gpt-5-codex', budgetTokens: 750_000, perDay: 2 });
      const back = new ImproveStore(dir, () => T0).state();

      // Y un fichero escrito antes de que esto se pudiera elegir: su
      // presupuesto se respeta y la elección queda heredada, que es lo que esa
      // instalación hacía.
      const old = mkdtempSync(join(tmpdir(), 'orca-improve-old-'));
      mkdirSync(join(old, IMPROVE_DIR), { recursive: true });
      writeFileSync(join(old, IMPROVE_DIR, IMPROVE_FILE), JSON.stringify({
        config: { paused: false, everyMin: 360, perDay: 4, minSignal: 40 },
        budgetTokens: 333_000, proposals: {}, reviews: [],
        usage: { since: T0, counts: {}, total: 0 }, signal: { since: T0, counts: {}, total: 0 },
      }));
      const migrated = new ImproveStore(old, () => T0).state();
      rmSync(old, { recursive: true, force: true });

      return ok('nothing is lost and nothing is invented',
        back.runtime === 'codex' && back.model === 'gpt-5-codex'
        && back.budgetTokens === 750_000 && back.config.perDay === 2
        && migrated.budgetTokens === 333_000 && migrated.runtime === null && migrated.model === null,
        `${back.runtime}/${back.model} ${back.budgetTokens} · migrated ${migrated.budgetTokens}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a manual run skips the clock and the signal, and the budget is configurable', async () => {
    const r = rig({ ORCA_IMPROVE_BUDGET_TOKENS: '150000' });
    const api = improveApi(r);
    try {
      const asked = await api.run('manual');
      return ok('the operator can always ask, at the ceiling they set',
        asked.ok && r.sent.length === 1 && r.budgets[0]!.tokens === 150_000,
        String(r.budgets[0]?.tokens));
    } finally { api.stop(); r.done(); }
  }),

  test('a reviewer never triggers the next review: its own work is not signal', async () => {
    const r = rig();
    const api = improveApi(r);
    try {
      await api.run('manual');
      const a = worker();
      r.arrive(a);
      api.report({ agentId: 'rev1', reviewId: null, proposals: [draft()] });
      r.move(a, 'done');
      // Todo lo que el revisor hizo pasó por el hub, y nada de ello cuenta.
      const signal = api.store.signal().total;
      r.clock.advance(IMPROVE_DEFAULTS.everyMin * 60_000 * 3);
      await settle();
      return ok('one launch, and no second one out of its own noise',
        signal === 0 && r.sent.filter((c) => c.k === 'spawn').length === 1,
        `signal=${signal} spawns=${r.sent.length}`);
    } finally { api.stop(); r.done(); }
  }),

  test('a read after more than 48 h keeps the last 24 h instead of emptying the window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      let now = T0;
      const store = new ImproveStore(dir, () => now);
      for (let i = 0; i < 5; i++) store.record('ui:cmd');
      now = T0 + 47 * HOUR;
      for (let i = 0; i < 3; i++) store.record('mcp:spawn_agent');
      store.record('gesture:win:agent');
      now = T0 + 49 * HOUR;
      // Antes, esta lectura reemplazaba la ventana por una vacía: el revisor
      // veía cero herramientas, cero peticiones y cero gestos.
      const first = store.usage();
      const again = store.usage();
      const expectSince = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
      return ok('the old hour leaves, the recent ones stay, and reading twice changes nothing',
        first.counts['mcp:spawn_agent'] === 3 && first.counts['gesture:win:agent'] === 1
        && first.counts['ui:cmd'] === undefined && first.total === 4
        && first.since === expectSince
        && JSON.stringify(again) === JSON.stringify(first),
        JSON.stringify(first));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the window slides an hour at a time: a count leaves 24 h after its hour, not all at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      let now = Math.floor(T0 / HOUR) * HOUR + 10 * 60_000;   // hh:10
      const start = now;
      const store = new ImproveStore(dir, () => now);
      store.record('mcp:a');
      now = start + 5 * HOUR;
      store.record('mcp:b');
      now = start + 23 * HOUR + 40 * 60_000;                    // la hora 23: todo dentro
      const full = store.usage().total;
      now = start + 24 * HOUR;                                  // sale la hora de `a`, no la de `b`
      const slid = store.usage();
      return ok('24 buckets, oldest out first',
        full === 2 && slid.counts['mcp:a'] === undefined && slid.counts['mcp:b'] === 1,
        `${full} → ${JSON.stringify(slid.counts)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the counts survive reloading the store: the timer saves them, and so does the shutdown', async () => {
    const r = rig({ ORCA_IMPROVE_PAUSED: '1' });
    const api = improveApi(r);
    let stopped = false;
    try {
      for (let i = 0; i < 4; i++) api.record('mcp:spawn_agent');
      api.record('ui:improve:get');
      const beforeTimer = new ImproveStore(r.dir, r.clock.now).usage().total;
      r.clock.advance(USAGE_SAVE_MS);
      const afterTimer = new ImproveStore(r.dir, r.clock.now).usage();
      // Lo que llegó después del último tic lo guarda el cierre del hub.
      api.record('mcp:ask_human');
      api.stop(); stopped = true;
      const afterStop = new ImproveStore(r.dir, r.clock.now);
      const u = afterStop.usage();
      return ok('nothing recorded is lost to a restart, the signal included',
        beforeTimer === 0 && afterTimer.counts['mcp:spawn_agent'] === 4 && afterTimer.total === 5
        && u.counts['mcp:ask_human'] === 1 && u.total === 6 && afterStop.signal().total === 6
        && u.since === afterTimer.since,
        `timer ${beforeTimer} → ${afterTimer.total} · stop ${u.total}`);
    } finally { if (!stopped) api.stop(); r.done(); }
  }),

  test('an old file with one flat window is folded into the ring, not thrown away', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const now = T0 + 30 * 60_000;
      const lastReview = T0 - 20 * 60_000;
      mkdirSync(join(dir, IMPROVE_DIR), { recursive: true });
      // La forma del fichero real de hoy: la ventana vaciada al lanzar la
      // revisión (since = lanzamiento − 24 h) y todo lo contado después está
      // también en `signal`.
      writeFileSync(join(dir, IMPROVE_DIR, IMPROVE_FILE), JSON.stringify({
        ...emptyState(T0),
        usage: { since: lastReview - 24 * HOUR, counts: { 'mcp:spawn_agent': 4, 'ui:cmd': 7 }, total: 11 },
        signal: { since: lastReview, counts: { 'mcp:spawn_agent': 4, 'ui:cmd': 7 }, total: 11 },
      }));
      const store = new ImproveStore(dir, () => now);
      const u = store.usage();
      // Y al volver a guardarlo, un hub anterior sigue encontrando su `usage`.
      store.record('ui:cmd');
      store.flush();
      const onDisk = JSON.parse(readFileSync(join(dir, IMPROVE_DIR, IMPROVE_FILE), 'utf8')) as ImproveState & { usageHours: unknown[] };
      return ok('the counts stay, dated from the last review, and the file keeps both shapes',
        u.counts['mcp:spawn_agent'] === 4 && u.counts['ui:cmd'] === 7 && u.total === 11
        && u.since === lastReview
        && onDisk.usage.counts['ui:cmd'] === 8 && Array.isArray(onDisk.usageHours) && onDisk.usageHours.length >= 1,
        JSON.stringify(u));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the report dates its counters, and a review launched after a quiet stretch still sees them', async () => {
    const r = rig({ ORCA_IMPROVE_PAUSED: '1' });
    const api = improveApi(r);
    try {
      for (let i = 0; i < 3; i++) api.record('mcp:spawn_agent');
      r.clock.advance(49 * HOUR);
      for (let i = 0; i < 2; i++) api.record('mcp:ask_human');
      api.record('ui:improve:get');
      r.clock.advance(HOUR);
      await api.run('manual');
      const prompt = spawnOf(r)?.prompt ?? '';
      const line = prompt.split('\n').find((l) => l.includes('window since')) ?? '';
      return ok('the brief says since when, and the counts are there',
        /window since \d{4}-\d\d-\d\dT\d\d:\d\dZ \(\d+(\.\d)?h of the last 24h\); a zero means none since then/.test(line)
        && prompt.includes('capcom tool calls (2): ask_human 2')
        && prompt.includes('console requests to the hub (1)'),
        line.trim());
    } finally { api.stop(); r.done(); }
  }),

  test('the telemetry is counts and codes: no paths, no transcripts, no secrets', () => {
    const digest = buildDigest({
      stats: emptyStats(),
      usage: { since: T0, counts: { 'mcp:spawn_agent': 12, 'ui:ceo:say': 40, 'mcp:ask_human': 3 }, total: 55 },
      fleet: { agents: 4, blocked: 1, missionsOpen: 2, missionsOwed: 1 },
      windowMs: 86_400_000,
    });
    const text = digest.lines.join('\n');
    const prompt = reviewerBrief({ reviewId: 'rev_1', digest, openProposals: [], answered: [], projectName: 'orca' });
    return ok('the whole report is numbers and names',
      text.includes('spawn_agent 12') && text.includes('ceo:say 40')
      && text.includes('escalations: 4') && text.includes('AX 3L')
      && !/\/(Users|home|var)\//.test(text) && !text.includes('sk-')
      && prompt.includes('never invent a number') && prompt.includes('You do not implement anything'),
      digest.lines[0]);
  }),

  test('report_improvements files, and says exactly why it refused a draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      const ctx = ctxWith(store);
      const out = await runImproveTool(ctx, 'report_improvements', {
        review_id: 'rev_1',
        proposals: [draft(), draft({ title: 'A wild guess', kind: 'observed', evidence: [] })],
      });
      const listed = await runImproveTool(ctx, 'list_improvements', {});
      const noted = await runImproveTool(ctx, 'note_improvement', {
        proposal_id: Object.keys(store.state().proposals)[0]!, text: 'on it',
      });
      return ok('one filed, one rejected with a reason a model can act on',
        !!out && out.result.includes('"filed": 1') && out.result.includes('must cite the measurements')
        && !!listed && listed.summary.includes('1 open')
        && !!noted && noted.summary.includes('answered'),
        out?.summary);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('without the section mounted the tools say so instead of throwing', async () => {
    const out = await runImproveTool({} as CeoContext, 'list_improvements', {});
    const other = await runImproveTool({} as CeoContext, 'list_fleet', {});
    return ok('unavailable, not a crash, and it keeps its hands off other tools',
      !!out && out.isError === true && out.result.includes('not available') && other === null);
  }),

  test('the board is pruned from the closed end, never from what is still open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      let now = T0;
      const store = new ImproveStore(dir, () => now);
      // Más de lo que cabe, la mitad cerradas y más viejas.
      for (let i = 0; i < MAX_PROPOSALS + 10; i++) {
        now += 1000;
        const id = store.file('rev', [draft({ key: `idea-${i}`, title: `Idea number ${i}` })]).proposals[0]!.id;
        if (i % 2 === 0) store.act(id, { act: 'dismiss' });
      }
      const state = store.state();
      const counts = improveCounts(state, now);
      const total = Object.keys(state.proposals).length;
      return ok('nothing undecided was thrown away',
        total <= MAX_PROPOSALS && counts.open === Math.ceil((MAX_PROPOSALS + 10) / 2) - 0,
        `total=${total} open=${counts.open} dismissed=${counts.dismissed}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('a duplicate is found by key first and by title second', () => {
    const state = emptyState(T0);
    const p = {
      id: 'imp_1', key: 'queue-order', reviewId: 'r', at: T0, updatedAt: T0,
      title: 'Queue order by age', area: 'ui' as const, kind: 'observed' as const,
      summary: 's', evidence: ['x'], status: 'open' as const, raised: 1, lastRaisedAt: T0, notes: [],
    };
    state.proposals[p.id] = p;
    return ok('both routes lead to the same row',
      findDuplicate(state, 'queue-order', 'anything else')?.id === 'imp_1'
      && findDuplicate(state, 'unrelated-key', 'QUEUE  ORDER by age!')?.id === 'imp_1'
      && findDuplicate(state, 'unrelated-key', 'Something completely different') === null);
  }),

  /*
   * La misión le devuelve a la propuesta su cierre y su archivo. Hasta aquí el
   * enlace era de ida: una misión terminada dejaba la propuesta en `sent` y
   * una archivada la dejaba huérfana en el tablero.
   */
  test('a mission tells its proposal how it went, and takes it back when it comes back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      let now = T0;
      const store = new ImproveStore(dir, () => now);
      const id = store.file('rev_1', [draft()]).proposals[0]!.id;
      const other = store.file('rev_1', [draft({ key: 'other-idea', title: 'Another idea entirely' })]).proposals[0]!.id;
      store.act(id, { act: 'sent', missionId: 'mission_a' });
      store.act(other, { act: 'dismiss' });
      const mission = { id: 'mission_a', status: 'active' as const };

      now += 1000;
      const untouched = store.syncMission(mission).length;
      now += 1000;
      const done = store.syncMission({ ...mission, status: 'completed' });
      now += 1000;
      const archived = store.syncMission({ ...mission, status: 'completed', archivedAt: now });
      let reopenRefused = false;
      try { store.act(id, { act: 'reopen' }); } catch { reopenRefused = true; }
      now += 1000;
      const restored = store.syncMission({ ...mission, status: 'completed' });
      now += 1000;
      const back = store.syncMission(mission);
      const p = store.get(id);
      const words = p.notes.filter((n) => n.role === 'system').map((n) => n.text);
      return ok('completed and archived reach the proposal; unarchiving and reopening undo them',
        untouched === 0
        && done[0]?.status === 'completed' && archived[0]?.status === 'archived' && reopenRefused
        && restored[0]?.status === 'completed' && back[0]?.status === 'sent'
        && p.missionId === 'mission_a' && p.updatedAt === now
        && store.get(other).status === 'dismissed'
        && words.length === 4 && /completed/.test(words[0]!) && /archived/.test(words[1]!)
        && /restored/.test(words[2]!) && /reopened/.test(words[3]!)
        && new ImproveStore(dir, () => now).get(id).notes.length === 4,
        words.join(' | '));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('the start-up sweep catches what happened to the missions while nobody looked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-improve-'));
    try {
      const store = new ImproveStore(dir, () => T0);
      const a = store.file('rev_1', [draft()]).proposals[0]!.id;
      const b = store.file('rev_1', [draft({ key: 'purged-idea', title: 'An idea whose mission is gone' })]).proposals[0]!.id;
      const c = store.file('rev_1', [draft({ key: 'open-idea', title: 'An idea nobody sent' })]).proposals[0]!.id;
      store.act(a, { act: 'sent', missionId: 'mission_a' });
      store.act(b, { act: 'sent', missionId: 'mission_gone' });
      const changed = store.syncMissions({
        mission_a: { id: 'mission_a', status: 'completed', archivedAt: T0 },
        mission_c: { id: 'mission_c', status: 'completed' },
      });
      const again = store.syncMissions({ mission_a: { id: 'mission_a', status: 'completed', archivedAt: T0 } });
      return ok('only the linked proposal moves, once, and a purged mission leaves its proposal as it was',
        changed.length === 1 && changed[0]!.id === a && store.get(a).status === 'archived'
        && store.get(b).status === 'sent' && store.get(c).status === 'open' && again.length === 0,
        changed.map((p) => `${p.key}:${p.status}`).join(','));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),

  test('archived beats completed, failed stays sent, and the board sinks them in that order', () => {
    const words = [
      linkedStatus({ status: 'active' }), linkedStatus({ status: 'failed' }),
      linkedStatus({ status: 'completed' }), linkedStatus({ status: 'completed', archivedAt: T0 }),
      linkedStatus({ status: 'active', archivedAt: T0 }),
    ];
    const row = (id: string, status: ImproveProposal['status']): ImproveProposal => ({
      id, key: id, reviewId: 'r', at: T0, updatedAt: T0, title: id, area: 'ui', kind: 'observed',
      summary: 's', evidence: [], status, raised: 1, lastRaisedAt: T0, notes: [],
    });
    const order = sortProposals([
      row('archived', 'archived'), row('dismissed', 'dismissed'), row('completed', 'completed'),
      row('sent', 'sent'), row('open', 'open'),
    ], T0).map((p) => p.id).join(' ');
    return ok('one rule for the mission word, and closed work below open work',
      words.join(' ') === 'sent sent completed archived archived'
      && order === 'open sent completed dismissed archived',
      `${words.join(' ')} / ${order}`);
  }),
];

export default { suite: 'AUTOMEJORA', tests } satisfies TestModule;
