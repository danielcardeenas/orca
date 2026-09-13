/**
 * El canal agente ↔ agente, y la detección de colisiones.
 *
 * Las dos cosas que se prueban aquí fallan en silencio si fallan. Un mensaje
 * mal enrutado que se tira no deja rastro: no hay excepción, no hay línea de
 * log en la consola, sólo un agente que nunca se enteró de algo. Y una colisión
 * no detectada se ve exactamente igual que un repo sano hasta que alguien mira
 * el `git diff` al día siguiente y falta media tarde de trabajo.
 *
 * Todo corre en un directorio temporal. Nada toca ~/.claude ni ~/.orca reales.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CollisionIndex, absPathOf, isNoise } from '../src/collector/collisions.ts';
import type { CollisionAgent } from '../src/collector/collisions.ts';
import { MessageWatcher, clamp, expiryOf, inboxStem, isOutPayload } from '../src/collector/messages.ts';
import type { MessageDeps } from '../src/collector/messages.ts';
import { readReceipt, receiptsDir, writeReceipt } from '../bin/lib/receipt.mjs';
import type { AgentMessage } from '../src/shared/types.ts';
import type { LineBatch, TranscriptRef } from '../src/collector/watch.ts';
import { eq, ok, test, type TestModule } from './harness.ts';

/* ── andamiaje ────────────────────────────────────────────────────── */

const ROOTS: string[] = [];

function tmpProject(name = 'proj'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-msg-test-'));
  ROOTS.push(root);
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, '.orca', 'out'), { recursive: true });
  fs.mkdirSync(path.join(p, '.orca', 'in'), { recursive: true });
  return p;
}

function cleanup(): void {
  for (const r of ROOTS.splice(0)) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* da igual */ }
  }
}

/** Una flota falsa: lo mínimo que el watcher consulta para enrutar. */
interface Fleet {
  agents: Record<string, { callsign: string; projectId: string }>;
  projects: Record<string, { name: string; path: string }>;
}

function deps(fleet: Fleet, overrides: Partial<MessageDeps> = {}): MessageDeps {
  return {
    resolveAgent: (projectId, hint) => {
      if (hint && fleet.agents[hint]) return hint;
      for (const [id, a] of Object.entries(fleet.agents)) {
        if (a.projectId === projectId) return id;
      }
      return null;
    },
    agentByCallsign: (cs) => {
      for (const [id, a] of Object.entries(fleet.agents)) {
        if (a.callsign.toUpperCase() === cs.trim().toUpperCase()) {
          return { agentId: id, projectId: a.projectId };
        }
      }
      return null;
    },
    projectByName: (name) => {
      for (const [id, p] of Object.entries(fleet.projects)) {
        if (p.name.toLowerCase() === name.trim().toLowerCase()) return id;
      }
      return null;
    },
    callsignOf: (id) => fleet.agents[id]?.callsign ?? '??',
    ...overrides,
  };
}

/** Escribe un archivo de salida como lo haría un agente, y recoge lo emitido. */
async function sendFrom(
  watcher: MessageWatcher, projectPath: string, stem: string, payload: unknown,
  sink: AgentMessage[],
): Promise<AgentMessage | null> {
  const before = sink.length;
  const file = path.join(projectPath, '.orca', 'out', `${stem}.json`);
  fs.writeFileSync(file + '.tmpwrite', JSON.stringify(payload));
  fs.renameSync(file + '.tmpwrite', file);
  await watcher['scan'](); // el escaneo es privado a propósito; el test lo fuerza
  return sink[before] ?? null;
}

function makeWatcher(fleet: Fleet, projectId: string, projectPath: string): {
  w: MessageWatcher; sent: AgentMessage[];
} {
  const w = new MessageWatcher(deps(fleet));
  w.track(projectId, projectPath);
  const sent: AgentMessage[] = [];
  w.onMessage((m) => sent.push(m));
  return { w, sent };
}

/* ── colisiones: andamiaje ────────────────────────────────────────── */

function ref(key: string): TranscriptRef {
  return {
    path: `/tmp/${key}.jsonl`, slug: '-tmp-proj', sessionId: key,
    agentId: null, metaPath: null, workflowId: null, key,
  };
}

/**
 * Un lote con las líneas `file-history-delta` que Claude Code escribe de verdad
 * antes de tocar un archivo. La forma está copiada de un transcript real, con
 * `trackingPath` relativo y `realParentDir` absoluto, que es el caso mayoritario.
 */
function writes(key: string, root: string, files: [string, number][]): LineBatch {
  return {
    ref: ref(key),
    lines: files.map(([rel, at]) => ({
      type: 'file-history-delta',
      messageId: `m_${rel}_${at}`,
      snapshotMessageId: 's1',
      trackingPath: rel,
      backup: {
        backupFileName: 'abc@v1',
        version: 1,
        backupTime: new Date(at).toISOString(),
        realParentDir: path.join(root, path.dirname(rel)),
      },
      timestamp: new Date(at).toISOString(),
    })),
    bootstrap: false,
    mtimeMs: Date.now(),
    at: Date.now(),
  };
}

function agent(id: string, over: Partial<CollisionAgent> = {}): CollisionAgent {
  return { id, projectId: 'p1', machineId: 'm1', live: true, parentId: null, ...over };
}

/* ── tests ────────────────────────────────────────────────────────── */

const tests = [
  /* ── enrutado ───────────────────────────────────────────────── */

  test('un callsign conocido produce scope agent', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'K9', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'warning', to: 'K9', subject: '/v1/charges devuelve 402 en sandbox', agentId: 'a1',
    }, sent);
    if (!m) return ok('un callsign conocido produce scope agent', false, 'no se emitió nada');
    return ok('un callsign conocido produce scope agent',
      m.scope === 'agent' && m.toAgentId === 'a2' && m.fromAgentId === 'a1'
      && m.fromCallsign === 'Z1' && m.kind === 'warning',
      `${m.scope}/${m.toAgentId}`);
  }),

  test('project:<nombre> produce scope project', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p }, p2: { name: 'dijosi', path: '/nope' } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'handoff', to: 'project:dijosi', subject: 'terminé el cliente HTTP', agentId: 'a1',
    }, sent);
    if (!m) return ok('project:<nombre> produce scope project', false, 'no se emitió nada');
    return ok('project:<nombre> produce scope project',
      m.scope === 'project' && m.toProjectId === 'p2' && m.toAgentId === null,
      `${m.scope}/${m.toProjectId}`);
  }),

  test('to ausente, null o "fleet" produce scope fleet', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const a = await sendFrom(w, p, 'a', { kind: 'notice', subject: 'sin to', agentId: 'a1' }, sent);
    const b = await sendFrom(w, p, 'b', { kind: 'notice', to: null, subject: 'to null', agentId: 'a1' }, sent);
    const c = await sendFrom(w, p, 'c', { kind: 'notice', to: 'fleet', subject: 'a la flota', agentId: 'a1' }, sent);
    const all = [a, b, c];
    return ok('to ausente, null o "fleet" produce scope fleet',
      all.every((m) => m !== null && m.scope === 'fleet' && m.toAgentId === null
        && m.toProjectId === null),
      all.map((m) => m?.scope ?? 'null').join(','));
  }),

  test('un callsign inexistente se degrada, NO se pierde', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'ask', to: 'QQ', subject: '¿migraste la tabla de sesiones?', agentId: 'a1',
    }, sent);
    if (!m) return ok('un callsign inexistente se degrada, NO se pierde', false, 'se perdió');
    return ok('un callsign inexistente se degrada, NO se pierde',
      m.scope === 'project' && m.toProjectId === 'p1' && m.subject.includes('QQ')
      && m.subject.includes('no encontré'),
      m.subject);
  }),

  test('un project:<nombre> inexistente también se degrada con nota', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'notice', to: 'project:fantasma', subject: 'algo', agentId: 'a1',
    }, sent);
    return ok('un project:<nombre> inexistente también se degrada con nota',
      m !== null && m.scope === 'project' && m.toProjectId === 'p1'
      && m.subject.includes('fantasma'),
      m?.subject ?? 'null');
  }),

  /* ── validación ─────────────────────────────────────────────── */

  test('un archivo sin kind o sin subject no se emite y se descarta', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    await sendFrom(w, p, 'bad1', { to: 'Z1', subject: 'sin kind' }, sent);
    await sendFrom(w, p, 'bad2', { kind: 'notice' }, sent);
    await sendFrom(w, p, 'bad3', { kind: 'grito', subject: 'kind inventado' }, sent);
    const left = fs.readdirSync(path.join(p, '.orca', 'out'));
    return ok('un archivo sin kind o sin subject no se emite y se descarta',
      sent.length === 0 && left.length === 0,
      `emitidos=${sent.length} restantes=${left.length}`);
  }),

  test('subject, body y files se recortan a los límites', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'notice',
      subject: 'x'.repeat(1000),
      body: 'y'.repeat(20_000),
      files: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
      agentId: 'a1',
    }, sent);
    if (!m) return ok('subject, body y files se recortan a los límites', false, 'no se emitió');
    return ok('subject, body y files se recortan a los límites',
      m.subject.length <= 300 && (m.body?.length ?? 0) <= 8000 && m.files.length === 20,
      `subject=${m.subject.length} body=${m.body?.length} files=${m.files.length}`);
  }),

  test('el mismo nombre de archivo reusado produce ids distintos', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const a = await sendFrom(w, p, 'reuse', { kind: 'notice', subject: 'primero', agentId: 'a1' }, sent);
    await new Promise((r) => setTimeout(r, 12));
    const b = await sendFrom(w, p, 'reuse', { kind: 'notice', subject: 'segundo', agentId: 'a1' }, sent);
    return ok('el mismo nombre de archivo reusado produce ids distintos',
      a !== null && b !== null && a.id !== b.id, `${a?.id} vs ${b?.id}`);
  }),

  /* ── bloqueos ───────────────────────────────────────────────── */

  test('un ask bloquea a quien lo manda', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'q1', {
      kind: 'ask', to: 'T1', subject: '¿ya migraste la tabla de sesiones?', agentId: 'a1',
    }, sent);
    const blocks = w.blocks();
    const b = blocks.get('a1');
    return ok('un ask bloquea a quien lo manda',
      m !== null && b !== undefined && b.messageId === m.id && b.waitingOn === 'a2'
      && b.since === m.at,
      b ? `${b.messageId} waitingOn=${b.waitingOn}` : 'sin bloqueo');
  }),

  test('un notice NO bloquea a nadie', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    for (const kind of ['notice', 'handoff', 'warning']) {
      await sendFrom(w, p, `n-${kind}`, { kind, to: 'T1', subject: `un ${kind}`, agentId: 'a1' }, sent);
    }
    return ok('un notice NO bloquea a nadie',
      sent.length === 3 && w.blocks().size === 0,
      `emitidos=${sent.length} bloqueos=${w.blocks().size}`);
  }),

  test('una respuesta desbloquea al que preguntó y llega a su buzón', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'q1', {
      kind: 'ask', to: 'T1', subject: '¿ya migraste?', agentId: 'a1',
    }, sent);
    if (!m) return ok('una respuesta desbloquea al que preguntó', false, 'no se emitió el ask');

    const res = await w.reply(m.id, 'sí, anoche', 'a2');
    const answerFile = path.join(p, '.orca', 'in', 'q1.answer.json');
    const answer = fs.existsSync(answerFile)
      ? JSON.parse(fs.readFileSync(answerFile, 'utf8')) as Record<string, unknown> : null;
    const updated = sent[sent.length - 1];

    return ok('una respuesta desbloquea al que preguntó y llega a su buzón',
      res.ok && w.blocks().size === 0 && answer !== null && answer['answer'] === 'sí, anoche'
      && answer['answeredByCallsign'] === 'T1'
      && updated?.id === m.id && updated.answer === 'sí, anoche' && updated.answeredBy === 'a2',
      JSON.stringify({ ok: res.ok, blocks: w.blocks().size, answer: answer?.['answer'] }));
  }),

  test('un replyTo en el buzón de salida cierra el ask, sin pasar por el hub', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'q1', {
      kind: 'ask', to: 'T1', subject: '¿ya migraste?', agentId: 'a1',
    }, sent);
    if (!m) return ok('un replyTo cierra el ask', false, 'no se emitió el ask');
    await sendFrom(w, p, 'r1', { replyTo: m.id, answer: 'sí', agentId: 'a2' }, sent);
    const answerFile = path.join(p, '.orca', 'in', 'q1.answer.json');
    return ok('un replyTo en el buzón de salida cierra el ask, sin pasar por el hub',
      w.blocks().size === 0 && fs.existsSync(answerFile),
      `bloqueos=${w.blocks().size}`);
  }),

  test('la respuesta reaparece como no leída aunque el ask ya se leyera', async () => {
    // El que pregunta y el que contesta pueden vivir en el MISMO proyecto, y
    // entonces el eco de la respuesta pisa el archivo que el destinatario ya
    // marcó leído. Sin borrar esa marca, `orca-read` diría "nothing new" con la
    // respuesta delante — el fallo silencioso exacto que este canal existe para
    // no tener.
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'q1', {
      kind: 'ask', to: 'T1', subject: '¿borro legacy_sessions?', agentId: 'a1',
    }, sent);
    if (!m) return ok('la respuesta reaparece como no leída', false, 'no se emitió');
    await w.deliverTo(p, m, 'a2');
    // El eco de la respuesta va al buzón DEL QUE PREGUNTÓ (a1), no al del que
    // la contesta: es su respuesta, y el nombre del archivo lo dice.
    const mark = path.join(p, '.orca', 'in', `${inboxStem(m.id, 'a1')}.read`);
    fs.writeFileSync(mark, '1');           // el destinatario lo leyó
    await w.reply(m.id, 'no, lo lee facturación', 'a2');
    const echo = JSON.parse(
      fs.readFileSync(path.join(p, '.orca', 'in', `${inboxStem(m.id, 'a1')}.json`), 'utf8'),
    ) as Record<string, unknown>;
    return ok('la respuesta reaparece como no leída aunque el ask ya se leyera',
      !fs.existsSync(mark) && echo['kind'] === 'notice'
      && String(echo['subject']).startsWith('re: ')
      && echo['body'] === 'no, lo lee facturación'
      && echo['answeredByCallsign'] === 'T1',
      JSON.stringify({ marca: fs.existsSync(mark), subject: echo['subject'] }));
  }),

  test('responder un mensaje desconocido no toca disco', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w } = makeWatcher(fleet, 'p1', p);
    const res = await w.reply('msg_inventado', 'hola', 'a1');
    const inbox = fs.readdirSync(path.join(p, '.orca', 'in'));
    return ok('responder un mensaje desconocido no toca disco',
      !res.ok && inbox.length === 0, `${res.detail} · ${inbox.length} archivos`);
  }),

  test('si el emisor desaparece, su ask deja de bloquear', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    await sendFrom(w, p, 'q1', { kind: 'ask', to: 'T1', subject: '¿?', agentId: 'a1' }, sent);
    const before = w.blocks().size;
    const dropped = w.forgetAgent('a1');
    return ok('si el emisor desaparece, su ask deja de bloquear',
      before === 1 && dropped.length === 1 && w.blocks().size === 0,
      `antes=${before} después=${w.blocks().size}`);
  }),

  /* ── entrega ────────────────────────────────────────────────── */

  test('deliverTo escribe el buzón y rechaza rutas de sistema', async () => {
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'm1', {
      kind: 'ask', to: 'T1', subject: 'entrégame', agentId: 'a1',
    }, sent);
    if (!m) return ok('deliverTo escribe el buzón', false, 'no se emitió');

    const good = await w.deliverTo(p, m, 'a2');
    // El archivo lleva el destinatario en el nombre: un proyecto tiene UN
    // buzón y hasta hoy el nombre no decía para quién era cada cosa.
    const file = path.join(p, '.orca', 'in', `${inboxStem(m.id, 'a2')}.json`);
    const written = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : null;
    const bad = await w.deliverTo('/etc', m, 'a2');
    const worse = await w.deliverTo('/', m, 'a2');

    return ok('deliverTo escribe el buzón y rechaza rutas de sistema',
      good.ok && written?.['subject'] === 'entrégame' && written['replyTo'] === m.id
      && written['to'] === 'a2'
      && !bad.ok && !worse.ok,
      `good=${good.ok} archivo=${path.basename(file)} etc=${bad.detail} root=${worse.detail}`);
  }),

  test('dos destinatarios, dos archivos: nadie se lleva el correo del otro', async () => {
    /*
     * El fallo del 2026-09-13, en una prueba. Un `.orca/in/` por proyecto, un
     * archivo por mensaje y una marca `.read` global: el primero que leía se
     * llevaba el correo de todos y los demás veían "nothing new". Le pasó a un
     * líder de squad tres veces en una mañana, la última con un mensaje suyo.
     *
     * Lo que se afirma aquí es lo que hace imposible repetirlo: una entrega por
     * destinatario, cada una con su nombre y su marca de leído.
     */
    const p = tmpProject();
    const fleet: Fleet = {
      agents: {
        a1: { callsign: 'Z1', projectId: 'p1' },
        a2: { callsign: 'T1', projectId: 'p1' },
        a3: { callsign: 'K9', projectId: 'p1' },
      },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'squad1', {
      kind: 'handoff', to: 'fleet', subject: 'para los dos', agentId: 'a1',
    }, sent);
    if (!m) return ok('dos destinatarios, dos archivos', false, 'no se emitió');

    await w.deliverTo(p, m, 'a2');
    await w.deliverTo(p, m, 'a3');

    const inbox = fs.readdirSync(path.join(p, '.orca', 'in')).filter((n) => n.endsWith('.json'));
    // T1 lee: pone SU marca, y la de K9 no existe.
    const markT1 = path.join(p, '.orca', 'in', `${inboxStem(m.id, 'a2')}.read`);
    const markK9 = path.join(p, '.orca', 'in', `${inboxStem(m.id, 'a3')}.read`);
    fs.writeFileSync(markT1, '1');

    return ok('dos destinatarios, dos archivos: nadie se lleva el correo del otro',
      inbox.length === 2
      && inbox.includes(`${inboxStem(m.id, 'a2')}.json`)
      && inbox.includes(`${inboxStem(m.id, 'a3')}.json`)
      && fs.existsSync(markT1) && !fs.existsSync(markK9),
      `${inbox.length} archivos · marca de K9 tras leer T1: ${fs.existsSync(markK9)}`);
  }),

  test('un mensaje viejo sin destinatario sigue siendo de todos', () => {
    /*
     * Había ~200 archivos ya depositados con el nombre antiguo cuando esto se
     * escribió, y a un mensaje ya entregado no se le puede inventar un
     * destinatario. Hacerlos invisibles habría cambiado un fallo por otro peor:
     * correo que existe y nadie ve.
     */
    return ok('un mensaje viejo sin destinatario sigue siendo de todos',
      inboxStem('msg_abc', null) === 'msg_abc'
      && inboxStem('msg_abc', 'a2') === 'msg_abc.a2',
      `${inboxStem('msg_abc', null)} · ${inboxStem('msg_abc', 'a2')}`);
  }),

  test('dos entregas a la vez del mismo mensaje no se pisan el temporal', async () => {
    /*
     * 288 avisos de «no pude escribir el buzón de entrada» en siete días, y ni
     * un mensaje perdido: `writeAtomic` derivaba el nombre del temporal sólo
     * del destino, así que dos entregas concurrentes compartían `.tmp`, el
     * primero en renombrar se lo llevaba y el resto fallaba con ENOENT. Esa
     * pista falsa desvió dos investigaciones de una pérdida que estaba en otro
     * sitio.
     *
     * Con el buzón por destinatario ya no coinciden ni en el destino, así que
     * esto afirma las dos mitades a la vez.
     */
    const p = tmpProject();
    const fleet: Fleet = {
      agents: {
        a1: { callsign: 'Z1', projectId: 'p1' },
        a2: { callsign: 'T1', projectId: 'p1' },
        a3: { callsign: 'K9', projectId: 'p1' },
      },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'race1', {
      kind: 'notice', to: 'fleet', subject: 'a la vez', agentId: 'a1',
    }, sent);
    if (!m) return ok('dos entregas a la vez', false, 'no se emitió');

    const out = await Promise.all([
      w.deliverTo(p, m, 'a2'), w.deliverTo(p, m, 'a3'),
      w.deliverTo(p, m, 'a2'), w.deliverTo(p, m, 'a3'),
    ]);
    const failed = out.filter((r) => !r.ok);
    return ok('dos entregas a la vez del mismo mensaje no se pisan el temporal',
      failed.length === 0,
      `${out.length} entregas · ${failed.length} fallos${failed[0] ? ` (${failed[0].detail})` : ''}`);
  }),

  test('el recibo del emisor pasa a delivered, y acumula destinatarios', async () => {
    /*
     * La otra mitad del recibo. `orca-tell` lo deja en `filed` y promueve solo
     * el primer salto a `picked` —la ausencia del archivo en el buzón de salida
     * ya lo prueba—, pero sólo el collector sabe el final. Sin esto, un emisor
     * no podía distinguir «nadie lo recogió» de «llegó y nadie ha contestado»,
     * que fue exactamente la confusión del 2026-09-13.
     */
    const p = tmpProject();
    const fleet: Fleet = {
      agents: {
        a1: { callsign: 'Z1', projectId: 'p1' },
        a2: { callsign: 'T1', projectId: 'p1' },
        a3: { callsign: 'K9', projectId: 'p1' },
      },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const dir = receiptsDir(p);
    writeReceipt(dir, 'r1', {
      msgId: 'r1', state: 'filed', to: 'fleet', kind: 'notice',
      recipients: [], detail: null, at: Date.now(), updatedAt: Date.now(),
    });
    const m = await sendFrom(w, p, 'r1', {
      kind: 'notice', to: 'fleet', subject: 'con recibo', agentId: 'a1',
    }, sent);
    if (!m) return ok('el recibo del emisor pasa a delivered', false, 'no se emitió');

    await w.deliverTo(p, m, 'a2');
    await w.deliverTo(p, m, 'a3');
    const after = readReceipt(dir, 'r1');
    // Un destinatario que falla NO degrada un mensaje que sí llegó a otros.
    await w.deliverTo('/etc', m, 'a2');
    const kept = readReceipt(dir, 'r1');

    return ok('el recibo del emisor pasa a delivered, y acumula destinatarios',
      after?.state === 'delivered'
      && after.recipients.join(',') === 'T1,K9'
      && kept?.state === 'delivered',
      `${after?.state} → ${after?.recipients.join(',')} · tras el fallo: ${kept?.state}`);
  }),

  test('sin recibo filiado aquí no se inventa ninguno', async () => {
    /*
     * Un mensaje cuyo emisor vive en otra máquina lo entrega este collector,
     * pero su recibo está en el disco del otro. Aquí no se escribe nada y el
     * emisor lee `picked`, que es la verdad. Un recibo que miente es peor que
     * uno incompleto: sobre él se construyen las decisiones equivocadas.
     */
    const p = tmpProject();
    const fleet: Fleet = {
      agents: { a1: { callsign: 'Z1', projectId: 'p1' }, a2: { callsign: 'T1', projectId: 'p1' } },
      projects: { p1: { name: 'proj', path: p } },
    };
    const { w, sent } = makeWatcher(fleet, 'p1', p);
    const m = await sendFrom(w, p, 'sinrecibo', {
      kind: 'notice', to: 'fleet', subject: 'sin recibo', agentId: 'a1',
    }, sent);
    if (!m) return ok('sin recibo filiado aquí no se inventa ninguno', false, 'no se emitió');
    await w.deliverTo(p, m, 'a2');
    const dir = receiptsDir(p);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return ok('sin recibo filiado aquí no se inventa ninguno',
      files.length === 0 && readReceipt(dir, 'sinrecibo') === null,
      `${files.length} recibos`);
  }),

  test('expiryOf: los notice caducan, los ask no', () => {
    const at = 1_000_000;
    return ok('expiryOf: los notice caducan, los ask no',
      expiryOf('notice', at, null) !== null
      && expiryOf('ask', at, null) === null
      && expiryOf('handoff', at, null) === null
      && expiryOf('ask', at, 30) === at + 30 * 60_000,
      'ttl explícito gana siempre');
  }),

  test('clamp recorta sin aplanar los saltos de línea del body', () => {
    const body = 'primera\nsegunda\ntercera';
    return ok('clamp recorta sin aplanar los saltos de línea del body',
      clamp(body, 100) === body && clamp('abcdef', 4).length === 4,
      clamp(body, 100).split('\n').length + ' líneas');
  }),

  test('isOutPayload acepta lo válido y rechaza lo demás', () => {
    return ok('isOutPayload acepta lo válido y rechaza lo demás',
      isOutPayload({ kind: 'ask', subject: 'x' })
      && !isOutPayload({ kind: 'ask' })
      && !isOutPayload({ kind: 'inventado', subject: 'x' })
      && !isOutPayload(null) && !isOutPayload([]),
      '');
  }),

  /* ── colisiones ─────────────────────────────────────────────── */

  test('dos agentes vivos escribiendo el mismo archivo colisionan', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    const root = '/repo';
    idx.ingest(writes('a1', root, [['src/api/charges.ts', now - 60_000]]), root);
    idx.ingest(writes('a2', root, [['src/api/charges.ts', now - 30_000]]), root);
    const { open } = idx.detect([agent('a1'), agent('a2')], now);
    const c = open[0];
    return ok('dos agentes vivos escribiendo el mismo archivo colisionan',
      open.length === 1 && c !== undefined
      && c.path === '/repo/src/api/charges.ts'
      && c.agentIds.join(',') === 'a1,a2'
      && c.lastSeen === now - 30_000 && c.acknowledged === false,
      c ? `${c.path} ${c.agentIds.join('+')}` : `${open.length} colisiones`);
  }),

  test('archivos distintos no colisionan', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('a1', '/repo', [['src/a.ts', now - 1000]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/b.ts', now - 1000]]), '/repo');
    return eq('archivos distintos no colisionan',
      idx.detect([agent('a1'), agent('a2')], now).open.length, 0);
  }),

  test('un padre y su subagente NO colisionan', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('root', '/repo', [['src/api.ts', now - 5000]]), '/repo');
    idx.ingest(writes('root#sub', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    const { open } = idx.detect(
      [agent('root'), agent('root#sub', { parentId: 'root' })], now);
    return eq('un padre y su subagente NO colisionan', open.length, 0);
  }),

  test('un nieto tampoco colisiona con su abuelo', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('g0', '/repo', [['src/api.ts', now - 5000]]), '/repo');
    idx.ingest(writes('g2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    const { open } = idx.detect([
      agent('g0'),
      agent('g1', { parentId: 'g0' }),
      agent('g2', { parentId: 'g1' }),
    ], now);
    return eq('un nieto tampoco colisiona con su abuelo', open.length, 0);
  }),

  test('dos hermanos SÍ colisionan: son dos escritores independientes', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('s1', '/repo', [['src/api.ts', now - 5000]]), '/repo');
    idx.ingest(writes('s2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    const { open } = idx.detect([
      agent('p'), agent('s1', { parentId: 'p' }), agent('s2', { parentId: 'p' }),
    ], now);
    return ok('dos hermanos SÍ colisionan: son dos escritores independientes',
      open.length === 1 && open[0]?.agentIds.join(',') === 's1,s2',
      open[0]?.agentIds.join('+') ?? 'ninguna');
  }),

  test('los archivos de ruido no colisionan', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    const noisy: [string, number][] = [
      ['package-lock.json', now - 1000],
      ['node_modules/foo/index.js', now - 1000],
      ['dist/bundle.js', now - 1000],
      ['.git/index', now - 1000],
      ['debug.log', now - 1000],
      ['.orca/out/x.json', now - 1000],
    ];
    idx.ingest(writes('a1', '/repo', noisy), '/repo');
    idx.ingest(writes('a2', '/repo', noisy), '/repo');
    const { open } = idx.detect([agent('a1'), agent('a2')], now);
    return ok('los archivos de ruido no colisionan',
      open.length === 0 && isNoise('/repo/node_modules/x.js') && isNoise('/repo/yarn.lock')
      && !isNoise('/repo/src/api.ts'),
      open.map((c) => c.path).join(', '));
  }),

  test('las escrituras fuera de la ventana no colisionan', () => {
    const idx = new CollisionIndex(60_000);
    const now = Date.now();
    idx.ingest(writes('a1', '/repo', [['src/api.ts', now - 10 * 60_000]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    return eq('las escrituras fuera de la ventana no colisionan',
      idx.detect([agent('a1'), agent('a2')], now).open.length, 0);
  }),

  test('un agente muerto no colisiona, y su colisión se limpia', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('a1', '/repo', [['src/api.ts', now - 5000]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    const first = idx.detect([agent('a1'), agent('a2')], now);
    // a2 muere: ya no hay dos escritores, así que la alerta deja de ser cierta.
    const second = idx.detect([agent('a1'), agent('a2', { live: false })], now);
    return ok('un agente muerto no colisiona, y su colisión se limpia',
      first.open.length === 1 && second.open.length === 0
      && second.cleared.length === 1 && second.cleared[0] === first.open[0]?.id
      && idx.list().length === 0,
      `cleared=${second.cleared.join(',')}`);
  }),

  test('una colisión viva no se re-emite en cada tick', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('a1', '/repo', [['src/api.ts', now - 5000]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    const agents = [agent('a1'), agent('a2')];
    const first = idx.detect(agents, now);
    const second = idx.detect(agents, now + 500);
    const third = idx.detect(agents, now + 1500);
    // Llega una escritura nueva bastante más tarde: ahí sí hay algo que contar.
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now + 120_000]]), '/repo');
    const fourth = idx.detect(agents, now + 121_000);
    return ok('una colisión viva no se re-emite en cada tick',
      first.open.length === 1 && second.open.length === 0 && third.open.length === 0
      && fourth.open.length === 1,
      `${first.open.length},${second.open.length},${third.open.length},${fourth.open.length}`);
  }),

  test('un snapshot por sí solo no abre una colisión', () => {
    // El backupTime de un snapshot es la hora del snapshot, no la de cada
    // escritura: 18 archivos re-sellados con 3 marcas de tiempo, medido en un
    // transcript real. Tomarlo como escritura fabricaría colisiones falsas.
    const idx = new CollisionIndex();
    const now = Date.now();
    const snap = (key: string, at: number): LineBatch => ({
      ref: ref(key),
      lines: [{
        type: 'file-history-snapshot',
        messageId: 'm1',
        isSnapshotUpdate: false,
        snapshot: {
          messageId: 'm1',
          timestamp: new Date(at).toISOString(),
          trackedFileBackups: {
            'src/api.ts': {
              backupFileName: 'x@v2', version: 2,
              backupTime: new Date(at).toISOString(),
              realParentDir: '/repo/src',
            },
          },
        },
      }],
      bootstrap: true, mtimeMs: at, at,
    });
    idx.ingest(snap('a1', now - 1000), '/repo');
    idx.ingest(snap('a2', now - 1000), '/repo');
    const onlySnapshots = idx.detect([agent('a1'), agent('a2')], now);
    // Con un delta de verdad de cada lado, sí.
    idx.ingest(writes('a1', '/repo', [['src/api.ts', now - 900]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now - 800]]), '/repo');
    const withDeltas = idx.detect([agent('a1'), agent('a2')], now);
    return ok('un snapshot por sí solo no abre una colisión',
      onlySnapshots.open.length === 0 && withDeltas.open.length === 1
      && idx.pathsOf('a1').includes('/repo/src/api.ts'),
      `snapshots=${onlySnapshots.open.length} deltas=${withDeltas.open.length}`);
  }),

  test('absPathOf normaliza el trackingPath relativo con realParentDir', () => {
    const rel = absPathOf('workers/api/index.ts',
      { realParentDir: '/Users/dan/proj/workers/api' }, '/Users/dan/proj');
    const abs = absPathOf('/private/tmp/scratch/x.mjs',
      { realParentDir: '/private/tmp/scratch' }, '/Users/dan/proj');
    const noAnchor = absPathOf('src/a.ts', {}, null);
    const viaCwd = absPathOf('src/a.ts', {}, '/repo');
    return ok('absPathOf normaliza el trackingPath relativo con realParentDir',
      rel === '/Users/dan/proj/workers/api/index.ts'
      && abs === '/private/tmp/scratch/x.mjs'
      && noAnchor === null && viaCwd === '/repo/src/a.ts',
      `${rel} · ${abs}`);
  }),

  test('olvidar un agente borra su historial de escrituras', () => {
    const idx = new CollisionIndex();
    const now = Date.now();
    idx.ingest(writes('a1', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    idx.ingest(writes('a2', '/repo', [['src/api.ts', now - 1000]]), '/repo');
    idx.detect([agent('a1'), agent('a2')], now);
    idx.forget('a2');
    const after = idx.detect([agent('a1'), agent('a2')], now);
    return ok('olvidar un agente borra su historial de escrituras',
      idx.pathsOf('a2').length === 0 && after.open.length === 0 && after.cleared.length === 1,
      `cleared=${after.cleared.length}`);
  }),

  test('el barrido no deja directorios temporales atrás', () => {
    cleanup();
    return ok('el barrido no deja directorios temporales atrás', ROOTS.length === 0);
  }),
];

const suite: TestModule = { suite: 'messages · agente ↔ agente y colisiones', tests };
export default suite;
