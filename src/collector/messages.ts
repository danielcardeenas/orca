/**
 * El canal agente → agente.
 *
 * Hermano de `escalate.ts`, y deliberadamente con la misma forma: un agente no
 * tiene socket, tiene un filesystem, así que hablar con otro agente es dejar un
 * archivo y esperar a que el collector lo recoja.
 *
 *   <project>/.orca/out/<id>.json            el agente manda algo
 *   <project>/.orca/in/<id>.<agente>.json    lo que le llega a ÉL (lo escribimos)
 *   <project>/.orca/in/<id>.<agente>.read    marca de leído (la escribe el agente)
 *   <project>/.orca/in/<id>.answer.json      la respuesta a un `ask` suyo
 *   <project>/.orca/receipts/<stem>.json     qué le pasó a lo que mandó
 *
 * El `.<agente>` del buzón de entrada es de hoy y arregla un fallo medido: un
 * proyecto tiene UN `.orca/in/`, y hasta ahora el fichero se llamaba sólo por
 * el id del mensaje y no decía a quién iba. Diecisiete agentes leyendo el mismo
 * directorio con `orca-read`, que no podía filtrar por destinatario porque el
 * dato no estaba, y una marca `.read` global: **el primero que leía se llevaba
 * el correo de todos** y los destinatarios veían `nothing new`. Le pasó al
 * líder de este mismo squad tres veces, la última consigo mismo.
 *
 * El nombre lleva el destinatario en vez de dejar que `orca-read` lo deduzca
 * del contenido porque quien enruta ya resolvió esa pregunta: el hub sabe qué
 * agentes de qué escuadrón reciben (`server.ts`, `routeMessage`) y llama aquí
 * una vez por cada uno. Que el CLI volviera a derivar el escuadrón por su
 * cuenta es exactamente la forma del fallo del worktree — dos lados resolviendo
 * lo mismo por separado, y discrepando. Aquí sólo se resuelve una vez.
 *
 * Dos invariantes mandan sobre todo lo demás:
 *
 *  1. **Un mensaje jamás se pierde en silencio.** Si el destinatario no existe,
 *     el mensaje NO se tira: se degrada a un aviso de proyecto y el subject lo
 *     dice. Un aviso mal dirigido se ignora en dos segundos; uno que nunca se
 *     emitió cuesta una tarde de depuración.
 *  2. **Sólo un `ask` bloquea.** Un `ask` sin responder pone a quien lo mandó en
 *     `block.kind = 'peer'`, y eso es exactamente lo que dibuja las cadenas de
 *     espera de la consola. Un `notice` no bloquea a nadie: si bloqueara, nadie
 *     mandaría notices.
 *
 * Nada de lo que llega por `.orca/out/` es de fiar: lo escribe un agente que
 * puede equivocarse, y a veces uno que está teniendo un mal día. Por eso aquí
 * se valida forma, tamaño y ruta antes de que nada salga al hub.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readReceipt, receiptsDir, writeReceipt } from '../../bin/lib/receipt.mjs';
import type { AgentMessage, MessageKind, MessageScope } from '../shared/types.ts';
import { squadName } from '../shared/squads.ts';
import {
  errText, guardAsync, isRecord, launchable, log, oneLine, safeJson, sha1, str,
} from './util.ts';

const SCOPE = 'messages';

export const OUT_DIR = path.join('.orca', 'out');
export const IN_DIR = path.join('.orca', 'in');

/* ── límites ──────────────────────────────────────────────────────── */

/** El subject va en una arista del mapa: si no cabe en una línea, no sirve. */
export const MAX_SUBJECT = 300;
export const MAX_BODY = 8_000;
export const MAX_FILES = 20;
const MAX_FILE_LEN = 400;
/** Un archivo de salida más grande que esto no es un mensaje, es un accidente. */
const MAX_OUT_BYTES = 256 * 1024;
/**
 * Un notice sin ttl caduca solo. Los notices son "por si a alguien le sirve", y
 * uno de anteayer sólo añade ruido al mapa. Un `ask` NUNCA caduca por defecto:
 * mientras nadie conteste, alguien está bloqueado de verdad, y hacerlo
 * desaparecer sería esconder el problema en lugar de resolverlo.
 */
const DEFAULT_NOTICE_TTL_MIN = 360;

/**
 * Cuántos emisores se recuerdan para poder anotarles el recibo, y por cuánto.
 * Un día es el TTL del propio recibo (`bin/lib/receipt.mjs`): recordar más
 * tiempo que el fichero que se va a escribir no sirve de nada.
 */
const MAX_TRACKED_SENT = 2_000;
const SENT_TTL_MS = 24 * 3600_000;

const KINDS = new Set<string>(['notice', 'ask', 'handoff', 'warning']);

/* ── estado interno ───────────────────────────────────────────────── */

interface Tracked {
  projectId: string;
  projectPath: string;
  outDir: string;
  inDir: string;
}

/** Un `ask` emitido y todavía sin respuesta. Es lo que bloquea a su emisor. */
interface OpenAsk {
  msg: AgentMessage;
  /** Buzón de entrada de QUIEN PREGUNTÓ: ahí va la respuesta. */
  inDir: string;
  /** Nombre local del archivo que escribió el agente, sin `.json`. */
  stem: string;
}

/** Un mensaje que ya dejamos en el buzón de alguien, para seguirle el `.read`. */
interface Delivered {
  msgId: string;
  agentId: string;
  file: string;
  readMark: string;
}

/**
 * De dónde salió un mensaje, para poder contestarle a su emisor qué pasó con
 * él.
 *
 * `orca-tell` deja un recibo en `filed` al mandar; el emisor promueve solo ese
 * primer salto a `picked` porque la ausencia del fichero en su buzón de salida
 * ya lo demuestra. Lo que sólo sabe el collector, y es lo que se anota aquí, es
 * el final: `delivered`, `undeliverable` o `read`.
 *
 * Hace falta el `stem` —el nombre que le puso el agente, `tell_xxx`— porque el
 * recibo se llama como él y el `msg.id` es un hash de otra cosa. Ese nombre
 * sólo se conoce al recoger el fichero, así que se guarda entonces.
 */
interface Sent {
  /** El directorio de recibos del emisor, ya resuelto. */
  dir: string;
  /** El nombre del fichero que escribió el agente, sin `.json`. */
  stem: string;
  at: number;
}

/**
 * Todo lo que este módulo necesita saber de la flota. No hay `projectPath` a
 * propósito: la ruta donde se escribe la entrega la resuelve y valida quien
 * llama (ver `deliverTo`), para que la comprobación viva junto al resto de la
 * postura de seguridad del collector en vez de duplicarse aquí.
 */
export interface MessageDeps {
  /**
   * Atribuye el archivo a un agente. El archivo puede declarar `agentId`; si no,
   * usamos el agente más activo del proyecto, igual que en escalate.ts.
   */
  resolveAgent(projectId: string, hint: string | null): string | null;
  /** Callsign ("K9") → agente vivo. null si esa etiqueta no existe. */
  agentByCallsign(callsign: string): { agentId: string; projectId: string } | null;
  /** Nombre, código o slug de proyecto → projectId. */
  projectByName(name: string): string | null;
  /** Callsign de un agente conocido, para el `fromCallsign` del mensaje. */
  callsignOf(agentId: string): string;
}

/** Lo que index.ts necesita para pintar un `block.kind = 'peer'`. */
export interface PeerBlock {
  messageId: string;
  waitingOn: string;
  summary: string;
  since: number;
}

export class MessageWatcher {
  private readonly deps: MessageDeps;
  private tracked = new Map<string, Tracked>();
  private open = new Map<string, OpenAsk>();
  private delivered = new Map<string, Delivered>();
  private sent = new Map<string, Sent>();
  private watchers = new Map<string, fs.FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private msgCbs: ((m: AgentMessage) => void)[] = [];
  private scanning = false;

  constructor(deps: MessageDeps) { this.deps = deps; }

  /**
   * Un mensaje nuevo, o uno que cambió (respondido, leído). El frame
   * `{t:'message'}` es un upsert por id, así que re-emitir es la forma correcta
   * de actualizar: el protocolo no tiene un `message:patch` y no hace falta.
   */
  onMessage(cb: (m: AgentMessage) => void): void { this.msgCbs.push(cb); }

  start(pollMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.scan(); }, pollMs);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* ya cerrado */ } }
    this.watchers.clear();
  }

  track(projectId: string, projectPath: string): void {
    const cur = this.tracked.get(projectId);
    if (cur && cur.projectPath === projectPath) return;
    this.untrack(projectId);
    this.tracked.set(projectId, {
      projectId,
      projectPath,
      outDir: path.join(projectPath, OUT_DIR),
      inDir: path.join(projectPath, IN_DIR),
    });
  }

  untrack(projectId: string): void {
    this.tracked.delete(projectId);
    const w = this.watchers.get(projectId);
    if (w) { try { w.close(); } catch { /* ya cerrado */ } this.watchers.delete(projectId); }
  }

  /** Los `ask` abiertos. El snapshot de reconexión los reenvía. */
  list(): AgentMessage[] {
    return [...this.open.values()].map((o) => o.msg);
  }

  get(id: string): AgentMessage | null {
    return this.open.get(id)?.msg ?? null;
  }

  /**
   * agentId → el bloqueo `peer` que le toca. Si un agente tiene varios `ask`
   * abiertos gana el más viejo: es el que lleva más tiempo parado y el que la
   * consola tiene que enseñar.
   */
  blocks(): Map<string, PeerBlock> {
    const out = new Map<string, PeerBlock>();
    for (const o of this.open.values()) {
      const from = o.msg.fromAgentId;
      if (!from) continue;
      const prev = out.get(from);
      if (prev && prev.since <= o.msg.at) continue;
      out.set(from, {
        messageId: o.msg.id,
        waitingOn: waitingOnOf(o.msg),
        summary: oneLine(`esperando a ${labelOf(o.msg)}: ${o.msg.subject}`, 200),
        since: o.msg.at,
      });
    }
    return out;
  }

  /* ── escaneo del buzón de salida ──────────────────────────────── */

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const t of this.tracked.values()) {
        this.attachWatch(t);
        // Que `.orca/out` no exista es el caso normal en casi todos los
        // proyectos: ni un log a 1Hz × N proyectos.
        const names = await readdirQuiet(t.outDir);
        if (names !== null) {
          for (const name of names) {
            if (!name.endsWith('.json') || name.endsWith('.answer.json')) continue;
            if (name.startsWith('.')) continue; // el .tmp del CLI a medio renombrar
            await this.take(t, path.join(t.outDir, name));
          }
        }
        await this.sweepRead(t);
      }
    } finally {
      this.scanning = false;
    }
  }

  private attachWatch(t: Tracked): void {
    if (this.watchers.has(t.projectId)) return;
    if (!fs.existsSync(t.outDir)) return;
    try {
      const w = fs.watch(t.outDir, () => { void this.scan(); });
      w.on('error', () => {
        try { w.close(); } catch { /* ya cerrado */ }
        this.watchers.delete(t.projectId);
      });
      this.watchers.set(t.projectId, w);
    } catch {
      // Sin watch queda el poll de 1s. Para un mensaje entre agentes que tardan
      // minutos por turno, un segundo de latencia no existe.
    }
  }

  /**
   * Recoge UN archivo de salida: valida, emite y lo borra.
   *
   * El borrado va después de emitir, igual que en escalate.ts y por la misma
   * razón: si el collector muere en medio, el peor caso es re-emitir el mismo
   * mensaje (el hub lo colapsa por id) en vez de perderlo.
   */
  private async take(t: Tracked, file: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      return; // se lo llevó otro tick
    }
    if (!stat.isFile()) return;
    if (stat.size > MAX_OUT_BYTES) {
      log('warn', SCOPE, `${file} pesa ${stat.size}B, descartado`);
      await fsp.unlink(file).catch(() => { /* da igual */ });
      return;
    }
    const text = await guardAsync(SCOPE, `leer ${path.basename(file)}`,
      () => fsp.readFile(file, 'utf8'), '');
    const obj = safeJson<Record<string, unknown>>(text);
    if (!obj) return; // escrito a medias: el próximo tick lo reintenta

    // Entero: `at` viaja por el cable y acaba en un reloj de la consola; los
    // microsegundos fraccionarios de birthtimeMs no aportan nada y ensucian.
    const at = Math.round(stat.birthtimeMs || stat.mtimeMs || Date.now());
    const stem = path.basename(file, '.json');

    // Una respuesta a un `ask` ajeno viaja por el mismo buzón, con `replyTo`.
    // Sin esto un `ask` sólo podría cerrarse desde la consola, y dos agentes
    // en la misma máquina no podrían terminar una conversación entre ellos.
    const replyTo = str(obj['replyTo']);
    if (replyTo) {
      const answer = str(obj['answer']) ?? str(obj['body']) ?? str(obj['subject']);
      const hint = str(obj['agentId']) ?? str(obj['sessionId']);
      const by = this.deps.resolveAgent(t.projectId, hint) ?? hint;
      if (answer) await this.reply(replyTo, answer, by);
      else log('warn', SCOPE, `${file} dice replyTo pero no trae respuesta`);
      await fsp.unlink(file).catch(() => { /* ya no está */ });
      return;
    }

    const msg = this.build(t, obj, at, file);
    if (!msg) {
      // Un archivo inválido no se reintenta eternamente: se descarta con ruido.
      log('warn', SCOPE, `${file} no es un mensaje válido, descartado`);
      await fsp.unlink(file).catch(() => { /* ya no está */ });
      return;
    }

    if (msg.kind === 'ask') {
      this.open.set(msg.id, { msg, inDir: t.inDir, stem });
    }
    // Dónde dejarle el recibo a quien lo mandó. Se apunta aquí porque éste es
    // el único momento en el que se ven a la vez el id que usará el hub y el
    // nombre con el que el agente lo conoce.
    this.rememberSender(msg.id, t.projectPath, stem);
    for (const cb of this.msgCbs) { try { cb(msg); } catch { /* aislar */ } }
    log('info', SCOPE, `${msg.kind}/${msg.scope} ${msg.id}: ${oneLine(msg.subject, 80)}`);

    await fsp.unlink(file).catch(() => { /* el agente lo retiró */ });
  }

  /** Valida y normaliza el payload del agente. null = no es un mensaje. */
  private build(
    t: Tracked, obj: Record<string, unknown>, at: number, file: string,
  ): AgentMessage | null {
    const kindRaw = str(obj['kind']);
    if (!kindRaw || !KINDS.has(kindRaw)) {
      log('warn', SCOPE, `${file}: kind inválido (${String(obj['kind'])})`);
      return null;
    }
    const kind = kindRaw as MessageKind;

    const subjectRaw = str(obj['subject']);
    if (!subjectRaw) {
      log('warn', SCOPE, `${file}: sin subject`);
      return null;
    }
    let subject = oneLine(subjectRaw, MAX_SUBJECT);

    const hint = str(obj['agentId']) ?? str(obj['sessionId']);
    const fromAgentId = this.deps.resolveAgent(t.projectId, hint) ?? hint ?? 'unknown';

    const route = this.route(obj['to'], t.projectId);
    if (route.note) {
      // El destinatario no existe. El mensaje SALE igual, degradado a proyecto,
      // y el subject lo dice: perder un mensaje en silencio es peor que
      // entregarlo mal, porque nadie puede depurar lo que no ocurrió.
      subject = oneLine(`[${route.note}] ${subject}`, MAX_SUBJECT);
    }

    const bodyRaw = obj['body'];
    const body = typeof bodyRaw === 'string' && bodyRaw.trim().length > 0
      ? clamp(bodyRaw, MAX_BODY) : null;

    const files = Array.isArray(obj['files'])
      ? obj['files']
        .filter((f): f is string => typeof f === 'string' && f.length > 0)
        .map((f) => oneLine(f, MAX_FILE_LEN))
        .slice(0, MAX_FILES)
      : [];

    const ttlMin = typeof obj['ttlMinutes'] === 'number' && Number.isFinite(obj['ttlMinutes'])
      ? Math.max(1, Math.min(60 * 24 * 30, obj['ttlMinutes']))
      : null;

    return {
      id: messageId(file, at),
      kind,
      scope: route.scope,
      fromAgentId,
      fromCallsign: this.deps.callsignOf(fromAgentId),
      fromProjectId: t.projectId,
      toAgentId: route.toAgentId,
      toProjectId: route.toProjectId,
      toSquad: route.toSquad,
      subject,
      body,
      files,
      at,
      readBy: [],
      expiresAt: expiryOf(kind, at, ttlMin),
      answer: null,
      answeredAt: null,
      answeredBy: null,
    };
  }

  /**
   * `to` → scope + destino. Cuatro formas y un degradado:
   *   "K9"                → agent    (si ese callsign existe ahora mismo)
   *   "project:dijosi"    → project
   *   "squad:audit-01"    → squad
   *   "fleet" | null | "" → fleet
   * Cualquier otra cosa que parezca un callsign y no lo sea cae a project del
   * emisor, con nota.
   *
   * Un `squad:` NO se comprueba aquí, y es deliberado: un escuadrón puede tener
   * miembros en otra máquina, y este collector sólo ve la suya. El hub es el
   * único que ve la flota entera, así que es el único que puede decir "en ese
   * escuadrón no hay nadie" — y lo dice, en el feed, en vez de tragárselo.
   */
  private route(to: unknown, fromProjectId: string): {
    scope: MessageScope; toAgentId: string | null; toProjectId: string | null;
    toSquad: string | null; note: string | null;
  } {
    const raw = typeof to === 'string' ? to.trim() : '';
    if (!raw || raw.toLowerCase() === 'fleet' || raw === '*') {
      return { scope: 'fleet', toAgentId: null, toProjectId: null, toSquad: null, note: null };
    }

    const lower = raw.toLowerCase();
    if (lower.startsWith('project:')) {
      const name = raw.slice('project:'.length).trim();
      const id = name ? this.deps.projectByName(name) : null;
      if (id) {
        return { scope: 'project', toAgentId: null, toProjectId: id, toSquad: null, note: null };
      }
      return {
        scope: 'project', toAgentId: null, toProjectId: fromProjectId, toSquad: null,
        note: `no encontré el proyecto ${oneLine(name, 40) || '(vacío)'}`,
      };
    }

    if (lower.startsWith('squad:')) {
      const name = squadName(raw.slice('squad:'.length));
      if (name) {
        return { scope: 'squad', toAgentId: null, toProjectId: null, toSquad: name, note: null };
      }
      return {
        scope: 'project', toAgentId: null, toProjectId: fromProjectId, toSquad: null,
        note: `escuadrón inválido ${oneLine(raw.slice('squad:'.length), 40) || '(vacío)'}`,
      };
    }

    const hit = this.deps.agentByCallsign(raw);
    if (hit) {
      return {
        scope: 'agent', toAgentId: hit.agentId, toProjectId: hit.projectId,
        toSquad: null, note: null,
      };
    }
    return {
      scope: 'project', toAgentId: null, toProjectId: fromProjectId, toSquad: null,
      note: `no encontré a ${oneLine(raw, 40)}`,
    };
  }

  /* ── recibos: qué pasó con lo que mandaste ────────────────────── */

  private rememberSender(msgId: string, projectPath: string, stem: string): void {
    this.sent.set(msgId, { dir: receiptsDir(projectPath), stem, at: Date.now() });
    if (this.sent.size > MAX_TRACKED_SENT) this.forgetOldSent();
  }

  /**
   * El mapa es una comodidad, no un registro: se poda por edad y por tamaño.
   * Perder una entrada sólo cuesta un recibo que se queda en `picked`, que es
   * justo lo que este módulo hace cuando no sabe algo con certeza.
   */
  private forgetOldSent(now = Date.now()): void {
    for (const [id, s] of this.sent) {
      if (now - s.at > SENT_TTL_MS) this.sent.delete(id);
    }
    while (this.sent.size > MAX_TRACKED_SENT) {
      const oldest = this.sent.keys().next();
      if (oldest.done) break;
      this.sent.delete(oldest.value);
    }
  }

  /**
   * Anota en el recibo del emisor qué acabó pasando con su mensaje.
   *
   * Tres reglas, y las tres son sobre no mentir:
   *
   *  1. **Sin emisor conocido, no se escribe nada.** Un mensaje cuyo emisor
   *     está en otra máquina lo entrega este collector, pero su recibo vive en
   *     el disco del otro. Aquí se queda en `picked` y el emisor lee «la
   *     entrega está fuera del alcance de esta máquina», que es verdad. Un
   *     recibo que miente es peor que uno incompleto.
   *  2. **`delivered` no se degrada a `undeliverable`.** Un mensaje al
   *     escuadrón va a varios destinatarios y puede llegarle a tres y fallar
   *     con el cuarto. Llegó, y el recibo tiene que decir a quién.
   *  3. **`read` es el final.** Que alguien lo leyera no lo devuelve a
   *     entregado en la siguiente entrega de la misma tanda.
   *
   * Best-effort y síncrono a propósito: es una nota al margen del canal, y si
   * el disco del emisor no se deja escribir, el mensaje ya está entregado. No
   * puede tirar una entrega que sí ocurrió.
   */
  private noteReceipt(
    msgId: string,
    change: { state: 'delivered' | 'undeliverable' | 'read'; recipient?: string; detail?: string },
  ): void {
    const s = this.sent.get(msgId);
    if (!s) return;
    try {
      const now = Date.now();
      const prev = readReceipt(s.dir, s.stem);
      if (!prev) return;   // nunca se filió desde aquí: no es nuestro recibo
      if (prev.state === 'read' && change.state !== 'read') return;
      if (prev.state === 'delivered' && change.state === 'undeliverable') return;

      const recipients = change.recipient && !prev.recipients?.includes(change.recipient)
        ? [...(prev.recipients ?? []), change.recipient]
        : (prev.recipients ?? []);

      writeReceipt(s.dir, s.stem, {
        ...prev,
        state: change.state,
        recipients,
        detail: change.detail ?? prev.detail ?? null,
        updatedAt: now,
      });
    } catch (err) {
      log('debug', SCOPE, `recibo de ${msgId}: ${errText(err)}`);
    }
  }

  /* ── entrega ──────────────────────────────────────────────────── */

  /**
   * Deja el mensaje en el buzón de entrada de un proyecto.
   *
   * `projectPath` tiene que venir ya validado contra el registro de proyectos
   * (ver commands.ts). Aquí se vuelve a comprobar contra las raíces del sistema
   * porque una defensa que sólo existe en el llamador es una defensa que la
   * próxima refactorización se lleva por delante.
   */
  async deliverTo(
    projectPath: string, msg: AgentMessage, recipientAgentId: string | null,
  ): Promise<{ ok: boolean; detail?: string }> {
    const allowed = launchable(projectPath);
    if (!allowed.ok) return { ok: false, detail: allowed.why };
    if (!isDir(projectPath)) return { ok: false, detail: `la ruta no existe: ${projectPath}` };
    if (!ID_RE.test(msg.id)) return { ok: false, detail: `id de mensaje inválido: ${msg.id}` };

    const inDir = path.join(projectPath, IN_DIR);
    const stem = inboxStem(msg.id, recipientAgentId);
    const file = path.join(inDir, `${stem}.json`);
    const readMark = path.join(inDir, `${stem}.read`);
    const ok = await writeAtomic(file, inboxPayload(msg, recipientAgentId));
    if (!ok) {
      const detail = 'no pude escribir el buzón de entrada';
      this.noteReceipt(msg.id, { state: 'undeliverable', detail });
      return { ok: false, detail };
    }

    if (recipientAgentId) {
      this.delivered.set(`${msg.id}:${recipientAgentId}`, {
        msgId: msg.id, agentId: recipientAgentId, file, readMark,
      });
    }
    this.noteReceipt(msg.id, {
      state: 'delivered',
      ...(recipientAgentId ? { recipient: this.deps.callsignOf(recipientAgentId) } : {}),
    });
    log('info', SCOPE, `entregado ${msg.id} en ${inDir} para ${recipientAgentId ?? 'todos'}`);
    return { ok: true };
  }

  /**
   * Cierra un `ask`: escribe la respuesta en el buzón de quien preguntó y le
   * quita el bloqueo `peer`.
   *
   * La respuesta se escribe DOS veces a propósito:
   *   <stem>.answer.json  el nombre que el emisor conoce, para `orca-tell --wait`
   *   <id>.json           un mensaje de entrada normal, para que salga en `orca-read`
   * Un agente que espera bloqueado usa la primera; uno que ya siguió con otra
   * cosa se entera por la segunda.
   */
  async reply(
    messageId: string, answer: string, by: string | null,
  ): Promise<{ ok: boolean; detail?: string }> {
    const o = this.open.get(messageId);
    if (!o) return { ok: false, detail: `mensaje desconocido o ya respondido: ${messageId}` };
    if (typeof answer !== 'string' || !answer.trim()) {
      return { ok: false, detail: 'respuesta vacía' };
    }
    const at = Date.now();
    const text = clamp(answer, MAX_BODY);

    const payload = {
      id: o.msg.id,
      replyTo: o.msg.id,
      subject: o.msg.subject,
      answer: text,
      at,
      answeredBy: by,
      answeredByCallsign: by ? this.deps.callsignOf(by) : null,
    };
    const wrote = await writeAtomic(path.join(o.inDir, `${o.stem}.answer.json`), payload);
    if (!wrote) return { ok: false, detail: 'no pude escribir la respuesta' };

    /*
     * El eco en el buzón normal es "mejor esfuerzo": si falla, el que esperaba
     * ya tiene su .answer.json, que es lo que de verdad lo desbloquea.
     *
     * Cuando el que pregunta y el que contesta viven en el MISMO proyecto, este
     * archivo es el mismo que se le entregó al destinatario, y puede tener ya su
     * marca `.read`. Borrarla es lo correcto: el contenido cambió, así que el
     * mensaje vuelve a ser nuevo. Sin esto la respuesta salía por el cable pero
     * `orca-read` decía "nothing new" — el fallo silencioso de manual.
     */
    // El eco va al buzón DE QUIEN PREGUNTÓ, y lleva su nombre: es su respuesta,
    // no correo del proyecto. Antes se escribía sin destinatario y cualquier
    // otro agente del mismo checkout podía consumirla antes que él.
    const echoStem = inboxStem(o.msg.id, o.msg.fromAgentId);
    await writeAtomic(path.join(o.inDir, `${echoStem}.json`), {
      ...inboxPayload(o.msg, o.msg.fromAgentId),
      kind: 'notice' as const,
      subject: oneLine(`re: ${o.msg.subject}`, MAX_SUBJECT),
      body: text,
      at,
      replyTo: null,
      answeredBy: by,
      answeredByCallsign: by ? this.deps.callsignOf(by) : null,
    });
    await fsp.unlink(path.join(o.inDir, `${echoStem}.read`)).catch(() => { /* nunca se leyó */ });
    for (const key of [...this.delivered.keys()]) {
      if (key === o.msg.id || key.startsWith(`${o.msg.id}:`)) this.delivered.delete(key);
    }

    o.msg.answer = text;
    o.msg.answeredAt = at;
    o.msg.answeredBy = by;
    this.open.delete(messageId);
    for (const cb of this.msgCbs) { try { cb(o.msg); } catch { /* aislar */ } }
    log('info', SCOPE, `${messageId} respondido por ${by ?? 'ORCA'}`);
    return { ok: true };
  }

  /**
   * El agente escribió su `<id>.<agente>.read`: el contrato tiene `readBy`, lo
   * llenamos, y el emisor se entera por su recibo.
   *
   * La marca es por agente desde hoy, así que `readBy` dice por fin quién leyó
   * de verdad. Antes la marca era una sola para todos los destinatarios y el
   * primero en leer la ponía en nombre de los demás.
   */
  private async sweepRead(t: Tracked): Promise<void> {
    if (this.delivered.size === 0) return;
    for (const [key, d] of this.delivered) {
      if (!d.file.startsWith(t.inDir + path.sep)) continue;
      if (!fs.existsSync(d.readMark)) continue;
      this.delivered.delete(key);
      this.noteReceipt(d.msgId, { state: 'read', recipient: this.deps.callsignOf(d.agentId) });
      const o = this.open.get(d.msgId);
      if (!o || o.msg.readBy.includes(d.agentId)) continue;
      o.msg.readBy.push(d.agentId);
      for (const cb of this.msgCbs) { try { cb(o.msg); } catch { /* aislar */ } }
    }
  }

  /**
   * Barre los que pasaron su `expiresAt`. Un `ask` no llega aquí salvo que su
   * emisor pidiera un ttl explícito; si lo pidió, respetamos su decisión.
   */
  reapExpired(now = Date.now()): string[] {
    const out: string[] = [];
    for (const [id, o] of this.open) {
      if (o.msg.expiresAt !== null && o.msg.expiresAt < now) {
        this.open.delete(id);
        out.push(id);
      }
    }
    return out;
  }

  /**
   * El emisor murió esperando: el `ask` deja de bloquear a nadie porque ya no
   * hay nadie a quien bloquear. Devuelve los ids retirados.
   */
  forgetAgent(agentId: string): string[] {
    const out: string[] = [];
    for (const [id, o] of this.open) {
      if (o.msg.fromAgentId !== agentId) continue;
      this.open.delete(id);
      out.push(id);
    }
    return out;
  }
}

/* ── helpers de módulo ────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Id estable y global. Se mezcla `at` con la ruta porque, a diferencia de una
 * escalación, el archivo de salida se borra al recogerlo: un agente que reusa
 * `out/1.json` para su segundo mensaje debe producir un id distinto, o el hub
 * creería que el primero cambió de opinión.
 */
export function messageId(file: string, at: number): string {
  return 'msg_' + sha1(`${path.resolve(file)} ${at}`).slice(0, 16);
}

/** Quién debe la respuesta. Un ask a un proyecto o a la flota no señala a nadie. */
function waitingOnOf(m: AgentMessage): string {
  if (m.scope === 'agent' && m.toAgentId) return m.toAgentId;
  if (m.scope === 'project' && m.toProjectId) return `project:${m.toProjectId}`;
  if (m.scope === 'squad' && m.toSquad) return `squad:${m.toSquad}`;
  return 'fleet';
}

function labelOf(m: AgentMessage): string {
  if (m.scope === 'agent' && m.toAgentId) return m.toAgentId.slice(0, 8);
  if (m.scope === 'project') return 'el proyecto';
  if (m.scope === 'squad') return `el escuadrón ${m.toSquad ?? '?'}`;
  return 'la flota';
}

/** Los notice caducan; los ask no, salvo que su emisor lo pidiera. */
export function expiryOf(kind: MessageKind, at: number, ttlMin: number | null): number | null {
  if (ttlMin !== null) return at + ttlMin * 60_000;
  if (kind === 'notice') return at + DEFAULT_NOTICE_TTL_MIN * 60_000;
  return null;
}

/**
 * El nombre del fichero en el buzón de entrada: el mensaje, y para quién.
 *
 * Sin destinatario conocido se cae al nombre de siempre, y eso significa «para
 * todo el que lea este buzón». Es el caso de los ~200 ficheros que ya estaban
 * depositados cuando esto se escribió: no llevan destinatario y no se les puede
 * inventar uno. Hacerlos desaparecer para todo el mundo cambiaría un fallo por
 * otro peor —correo que existe y nadie ve— así que se quedan visibles para
 * todos, como hasta hoy. Ver el filtro en `bin/orca-read.mjs`.
 */
export function inboxStem(msgId: string, recipientAgentId: string | null): string {
  return recipientAgentId && ID_RE.test(recipientAgentId)
    ? `${msgId}.${recipientAgentId}`
    : msgId;
}

/**
 * Lo que ve el agente en su buzón. Plano a propósito: `jq` tiene que bastar.
 *
 * `to`, `toAgentId` y `toSquad` son de hoy. El payload no decía a quién iba el
 * mensaje, y por eso `orca-read` no **podía** filtrar aunque quisiera: el dato
 * no existía en disco. El nombre del fichero es lo que decide quién lo ve
 * (`inboxStem`); estos campos son para que un agente —o un `jq`— pueda además
 * ver a quién iba dirigido y por qué le llegó.
 */
function inboxPayload(m: AgentMessage, recipientAgentId: string | null = null): Record<string, unknown> {
  return {
    id: m.id,
    kind: m.kind,
    scope: m.scope,
    from: m.fromCallsign,
    fromAgentId: m.fromAgentId,
    fromProjectId: m.fromProjectId,
    to: recipientAgentId,
    toAgentId: m.toAgentId,
    toSquad: m.toSquad,
    subject: m.subject,
    body: m.body,
    files: m.files,
    at: m.at,
    expiresAt: m.expiresAt,
    // Sólo un `ask` espera respuesta; el resto es informativo.
    replyTo: m.kind === 'ask' ? m.id : null,
  };
}

/** Corta sin aplanar: el body puede y debe ser multilínea. */
export function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * tmp + rename: el otro lado hace polling y no puede leer un JSON a medias.
 *
 * El temporal lleva pid + azar, y eso es el arreglo de un fallo medido. Antes
 * era `.${basename}.tmp`, un nombre derivado sólo del destino: correcto
 * mientras hubiera un escritor, y hay varios. `routeMessage` despacha un
 * `deliver` por destinatario y todos los de un mismo proyecto comparten `inDir`
 * y `msg.id`, o sea el mismo destino y el mismo temporal. El primero en
 * renombrar se llevaba el `.tmp`; los demás fallaban con ENOENT en el rename.
 *
 * No perdía un solo mensaje —el fichero es uno y lo escribe el que gana— pero
 * producía 288 avisos de «no pude escribir el buzón de entrada» en siete días,
 * 22 de ellos el 2026-09-13, y ésa fue la pista que desvió dos investigaciones
 * de una pérdida que estaba en otro sitio. Un aviso que salta siempre es un
 * aviso que nadie lee, y encima tapa al que sí importa.
 *
 * Misma forma que `trust.ts`, que ya lo hacía bien.
 */
async function writeAtomic(file: string, payload: unknown): Promise<boolean> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return true;
  } catch (err) {
    log('error', SCOPE, `no pude escribir ${file}: ${errText(err)}`);
    await fsp.unlink(tmp).catch(() => { /* nunca existió */ });
    return false;
  }
}

async function readdirQuiet(dir: string): Promise<string[] | null> {
  try {
    return await fsp.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('debug', SCOPE, `readdir ${dir}: ${errText(err)}`);
    }
    return null;
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Sólo para los tests: valida la forma de un buzón sin montar el watcher. */
export function isOutPayload(v: unknown): boolean {
  return isRecord(v)
    && typeof v['kind'] === 'string' && KINDS.has(v['kind'])
    && typeof v['subject'] === 'string' && v['subject'].length > 0;
}
