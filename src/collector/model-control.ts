/** Native CLI model selection. Never sends a model-change request to the LLM. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentHandle } from './commands.ts';
import type { TmuxHost } from './tmux.ts';
import type { ModelChoice, ModelControl } from '../shared/model-control.ts';
import { parseModelControl } from '../shared/model-control.ts';
import { peekIdentity, writeIdentity } from './capcom-identity.ts';

type Row = ModelChoice & { selected: boolean; index: number };
export function modelMenu(screen: string, runtime: string): Row[] {
  const heading = runtime === 'codex' ? 'Select Model and Effort' : 'Select model';
  const start = screen.lastIndexOf(heading);
  if (start < 0) return [];
  return screen.slice(start).split('\n').flatMap(line => {
    const m = /^\s*([›❯]?)\s*(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (!m) return [];
    const label = m[3]!.split(/\s{2,}/)[0]!.replace(/\s*✔/g, '').trim();
    const id = runtime === 'codex' ? label.split(' ')[0]! : label.split(' ')[0]!.toLowerCase();
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) return [];
    return [{ id, label: label.replace(/\s*\(current\)/, ''), index: Number(m[2]), selected: !!m[1] }];
  });
}

/** Lo que `capture-pane -e` intercala: SGR y el resto de CSI, OSC (enlaces) y cambios de juego de caracteres. */
const ESCAPES = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

/**
 * La pantalla tal como se ve (`plain`) y sólo lo que alguien tecleó (`typed`).
 *
 * Claude Code, al acabar un turno, sugiere el siguiente mensaje dentro del
 * propio cuadro de entrada: texto atenuado (SGR 2) que desaparece en cuanto se
 * teclea. Sin el atributo, un CAPCOM ocioso con el prompt vacío se leía como un
 * borrador a medias, y NEW CAPCOM y el menú de modelos se negaban justo cuando
 * les tocaba actuar. Lo que teclea una persona no se pinta atenuado, así que
 * `typed` lo descarta. Los saltos de línea se conservan siempre, para que las
 * dos versiones se puedan leer línea a línea en paralelo. Sobre texto sin
 * escapes, las dos son el propio texto.
 */
function screenText(screen: string): { plain: string; typed: string } {
  let plain = ''; let typed = ''; let dim = false; let last = 0;
  const text = (s: string) => { plain += s; typed += dim ? s.replace(/[^\n]/g, '') : s; };
  for (const m of screen.matchAll(ESCAPES)) {
    text(screen.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== 'm') continue;
    const ps = (m[1] || '0').split(';');
    for (let i = 0; i < ps.length; i++) {
      const p = Number(ps[i]!.split(':')[0] || 0);
      // 38/48/58;5;n y ;2;r;g;b son colores: su «2» no es atenuado.
      if ((p === 38 || p === 48 || p === 58) && !ps[i]!.includes(':')) { i += ps[i + 1] === '5' ? 2 : ps[i + 1] === '2' ? 4 : 0; continue; }
      if (p === 0 || p === 22) dim = false;
      else if (p === 2) dim = true;
    }
  }
  text(screen.slice(last));
  return { plain, typed };
}

/**
 * Refuse drafts, active turns and unknown dialogs rather than type into them.
 *
 * Give it a styled capture (`capture(…, { styled: true })`) wherever the
 * answer decides whether to type: only then is a dim suggestion told apart
 * from a draft. A plain capture still works, and still reads a suggestion as
 * a draft — the safe side.
 */
export function modelPromptReady(screen: string, runtime: string): boolean {
  const { plain, typed } = screenText(screen);
  if (/esc to interrupt|Esc to interrupt|Select Model|Select model|Select Reasoning|Do you want to proceed\?|Enter to confirm/i.test(plain.slice(-3500))) return false;
  const marker = runtime === 'codex' ? '›' : '❯';
  const lines = plain.replace(/\u00a0/g, ' ').split('\n');
  // La línea del prompt se busca en lo que se ve; lo que hay escrito en ella, en lo tecleado.
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (lines[i]!.trimStart().startsWith(marker)) at = i;
  if (at < 0) return false;
  const rest = (typed.split('\n')[at] ?? '').trim();
  const line = (rest.startsWith(marker) ? rest.slice(1) : rest).trim();
  return line === '' || (runtime === 'codex' ? line === 'Ask Codex to do anything' : /^Try "/.test(line));
}

/** tmux scrollback can retain the startup "model: loading" banner above the current one. */
export function resumedPromptReady(screen: string, runtime: string): boolean {
  const model = [...screenText(screen).plain.matchAll(/model:\s+(\S+)/g)].at(-1)?.[1];
  return model !== 'loading' && modelPromptReady(screen, runtime);
}

export function modelConfirmed(screen: string, runtime: string, choice: ModelChoice): boolean {
  const lines = screen.split('\n');
  if (runtime === 'codex') return lines.some(l => l.trim().startsWith(`• Model changed to ${choice.id} `));
  const family = choice.label.split(' ')[0]!.toLowerCase();
  return lines.some(l => /Set model to .* for this session only/.test(l)
    && l.toLowerCase().includes(`set model to ${family} `));
}

/**
 * ¿Pide Claude Code confirmar ESTE cambio, con el «sí» ya marcado?
 *
 * Desde 2.1.268, si la conversación tiene caché del modelo actual, `s` no
 * cambia el modelo: abre esto (capturado de una sesión real; pasa con
 * cualquier destino, no sólo con 1M, y no pasa si el modelo actual aún no ha
 * respondido nada):
 *
 *   Switch model?
 *   Your next response will be slower and use more tokens
 *   This conversation is cached for the current model. Switching to Opus 5 (1M context) means …
 *   ❯ 1. Yes, switch to Opus 5 (1M context)
 *     2. No, go back
 *
 * Sólo si la opción marcada nombra el modelo pedido, Enter confirma el mismo
 * cambio de esta sesión que ya se eligió con `s`.
 */
export function switchConfirmation(screen: string, choice: ModelChoice): boolean {
  const at = screen.lastIndexOf('Switch model?');
  if (at < 0) return false;
  const family = choice.label.split(' ')[0]!.toLowerCase();
  return screen.slice(at).split('\n').some(line => {
    const m = /^\s*❯\s*\d+\.\s+Yes, switch to (.+?)\s*$/.exec(line);
    return !!m && `${m[1]!.toLowerCase()} `.startsWith(`${family} `);
  });
}

/**
 * La primera línea del diálogo que el CLI tiene abierto, o null si no hay.
 *
 * Un diálogo es una opción numerada marcada al pie de la pantalla; su primera
 * línea, la que sigue al borde que lo abre. Sirve para decirle al operador qué
 * se está preguntando cuando nadie aquí sabe contestarlo.
 */
export function pendingDialog(screen: string): string | null {
  const lines = screenText(screen).plain.split('\n').filter(l => l.trim()).slice(-30);
  let option = -1;
  for (let i = lines.length - 1; i >= 0 && option < 0; i--) if (/^\s*[❯›]\s*\d+\.\s/.test(lines[i]!)) option = i;
  for (let i = option - 1; i >= 0; i--) {
    if (/^\s*[▔─━]{8,}\s*$/.test(lines[i]!)) return i + 1 < option ? lines[i + 1]!.trim().slice(0, 120) : null;
  }
  return null;
}

interface Deps {
  tmux: Pick<TmuxHost, 'capture' | 'paste' | 'keys'>;
  agent(id: string): AgentHandle | null;
  owns(a: AgentHandle): boolean;
  dir(id?: string): string | null;
  busy?(id: string): boolean;
  wait?(ms: number): Promise<void>;
  /**
   * Los modelos que un runtime instalado ofrece, sin preguntárselo a la sesión.
   *
   * El catálogo nativo (`choices`) sólo se llena tecleando `/model` en un CLI
   * ocioso con el prompt limpio, y un CAPCOM que manda una flota rara vez está
   * en ese instante cuando el operador abre el selector. Sin esto, cambiar de
   * modelo dentro del mismo proveedor dependía de pescar ese momento; con esto
   * se acepta la petición y es el menú real, al aplicarla, quien la confirma o
   * la rechaza. Es la misma fuente con la que ya se cruza de proveedor.
   */
  catalog?(runtime: string): ModelChoice[];
}

export class ModelController {
  private states = new Map<string, ModelControl>();
  private locks = new Set<string>();
  private loaded = new Set<string>();
  constructor(private deps: Deps) {}
  locked(id: string): boolean { return this.locks.has(id); }
  private wait(ms: number) { return this.deps.wait?.(ms) ?? new Promise<void>(r => setTimeout(r, ms)); }
  private file(id: string) {
    const dir = this.deps.dir(id);
    if (!dir || !/^[A-Za-z0-9_-]{4,72}$/.test(id)) throw new Error('agent control directory unavailable');
    return path.join(dir, `model-control-${id}.json`);
  }
  state(a: AgentHandle): ModelControl | undefined {
    if (!this.deps.owns(a) || !['codex', 'claude'].includes(a.runtime)) return;
    if (!this.loaded.has(a.sessionId)) {
      try {
        const saved = parseModelControl(JSON.parse(fs.readFileSync(this.file(a.sessionId), 'utf8')));
        if (!saved || saved.sessionId !== a.sessionId || saved.runtime !== a.runtime) return;
        if (saved.sessionId === a.sessionId) {
          // An interrupted write to a CLI must never be retried automatically.
          if (saved.phase === 'applying') { saved.phase = 'failed'; saved.detail = 'Change unconfirmed after restart. Check the terminal before retrying.'; }
          this.states.set(a.sessionId, saved);
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      this.loaded.add(a.sessionId);
    }
    let s = this.states.get(a.sessionId);
    if (!s) {
      s = { sessionId: a.sessionId, runtime: a.runtime, active: a.model ?? null, choices: [], phase: 'ready', requested: null, detail: '', events: [] };
      this.states.set(a.sessionId, s);
    }
    return structuredClone(s);
  }
  private save(s: ModelControl) {
    const file = this.file(s.sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.states.set(s.sessionId, structuredClone(s));
  }
  private target(id: string) {
    const a = this.deps.agent(id);
    if (!a || !this.deps.owns(a) || !a.pane || !a.alive || !['codex', 'claude'].includes(a.runtime)) throw new Error('An active hosted agent session is required.');
    return a;
  }
  private idle(a: AgentHandle) { return a.state === 'idle' || (a.state === 'blocked' && a.blockKind === 'error'); }
  /** ¿Lo ofrece el catálogo del proveedor, aunque esta sesión aún no lo haya confirmado? */
  private offered(runtime: string, model: string): boolean {
    try { return (this.deps.catalog?.(runtime) ?? []).some(c => c.id === model); } catch { return false; }
  }
  private async screen(a: AgentHandle, styled = false) {
    const r = await this.deps.tmux.capture(a.pane!, 80, styled ? { styled } : undefined);
    if (!r.ok) throw new Error(r.detail);
    return r.stdout;
  }
  private async keys(a: AgentHandle, keys: string[]) {
    const r = await this.deps.tmux.keys(a.pane!, keys);
    if (!r.ok) throw new Error(r.detail);
    await this.wait(180);
  }
  private async open(a: AgentHandle) {
    if (!this.idle(this.target(a.id)) || !modelPromptReady(await this.screen(a, true), a.runtime)) throw new Error('Clear the terminal input or finish its dialog, then try again.');
    const r = await this.deps.tmux.paste(a.pane!, '/model');
    if (!r.ok) throw new Error(r.detail);
    for (let i = 0; i < 12; i++) {
      await this.wait(150);
      const screen = await this.screen(a);
      const rows = modelMenu(screen, a.runtime);
      if (rows.length && rows.some(r => r.selected)) return rows;
    }
    throw new Error('CLI model menu not recognized. Check the terminal; no model was selected.');
  }
  async list(id: string): Promise<ModelControl> {
    const a = this.target(id);
    const s = this.state(a);
    if (!s) throw new Error('Model state could not be loaded.');
    if (this.locked(id) || this.deps.busy?.(id) || s.phase === 'queued' || !this.idle(a)) return s;
    this.locks.add(id);
    try {
      const rows = await this.open(a);
      s.choices = rows.filter(r => r.id !== 'default').map(({ id, label }) => ({ id, label }));
      s.active = rows.find(r => r.selected)?.id ?? s.active;
      await this.keys(a, ['Escape']);
      this.save(s);
      return s;
    } finally { this.locks.delete(id); }
  }
  request(id: string, model: string | null): ModelControl {
    const a = this.target(id);
    const s = this.state(a);
    if (!s || this.locked(id)) throw new Error('A model change is already being applied.');
    /*
     * Dos fuentes valen para encolar: lo que este CLI enseñó en su menú y lo
     * que el catálogo del proveedor dice que existe. La segunda no es una
     * promesa de que el menú lo ofrezca —eso lo comprueba `apply` contra la
     * pantalla real y lo deja en `failed` con su motivo si no—, pero sí basta
     * para no bloquear una elección legítima porque la sesión estaba ocupada.
     */
    if (model !== null && !s.choices.some(c => c.id === model) && !this.offered(a.runtime, model)) throw new Error('Refresh models and choose one offered by this CLI.');
    if (model === s.active) model = null;
    s.requested = model;
    s.phase = model ? 'queued' : 'ready';
    s.detail = model ? 'Waiting for the current turn to finish.' : '';
    this.save(s);
    return s;
  }
  tick(a: AgentHandle) {
    const s = this.state(a);
    if (!s || s.phase !== 'queued' || this.locked(a.id) || this.deps.busy?.(a.id) || !this.idle(a)) return;
    this.locks.add(a.id);
    void this.apply(a, s).finally(() => this.locks.delete(a.id));
  }
  private async apply(a: AgentHandle, s: ModelControl) {
    let menuOpen = false;
    try {
      s.phase = 'applying'; s.detail = 'Waiting for CLI confirmation.'; this.save(s);
      const before = await this.screen(a);
      const rows = await this.open(a); menuOpen = true;
      const choice = rows.find(r => r.id === s.requested);
      const current = rows.find(r => r.selected)!;
      if (!choice) throw new Error(`This CLI does not offer ${s.requested} in its model menu. No model was changed.`);
      if (current.id === choice.id) {
        await this.keys(a, ['Escape']); menuOpen = false;
        s.active = choice.id; s.phase = 'ready'; s.requested = null; s.detail = 'This model is already active. Same conversation.'; this.save(s); return;
      }
      s.active = current.id;
      const delta = rows.indexOf(choice) - rows.indexOf(current);
      if (delta) await this.keys(a, Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'));
      const selected = modelMenu(await this.screen(a), a.runtime).find(r => r.selected);
      if (selected?.id !== choice.id) throw new Error('CLI selection changed unexpectedly.');
      if (a.runtime === 'claude') {
        if (!(await this.screen(a)).includes('s to use this session only')) throw new Error('This Claude version does not offer a session-only change.');
        await this.keys(a, ['s']);
      } else {
        await this.keys(a, ['Enter']);
        const effort = await this.screen(a);
        if (effort.includes(`Select Reasoning Level for ${choice.id}`)) await this.keys(a, ['Enter']);
      }
      menuOpen = false;
      let confirmed = false; let answered = false;
      for (let i = 0; i < 15; i++) {
        const screen = await this.screen(a);
        const count = (text: string) => text.split('\n').filter(line => modelConfirmed(line, a.runtime, choice)).length;
        if (count(screen) > count(before)) { confirmed = true; break; }
        // Una sola vez: si el diálogo sigue ahí después, que lo vea una persona.
        if (a.runtime === 'claude' && !answered && switchConfirmation(screen, choice)) { await this.keys(a, ['Enter']); answered = true; continue; }
        await this.wait(150);
      }
      if (!confirmed) {
        const dialog = pendingDialog(await this.screen(a));
        throw new Error(dialog
          ? `Change unconfirmed. The CLI is asking "${dialog}". Open the terminal to answer it.`
          : 'Change unconfirmed. Open the terminal to finish or inspect the CLI dialog.');
      }
      if (this.target(a.id).sessionId !== s.sessionId) throw new Error('agent session changed while applying the model.');
      const event = { id: randomUUID(), at: Date.now(), from: s.active, to: choice.id,
        text: `Model changed: ${s.active ?? 'unknown'} → ${choice.id} · Same conversation. Applies to subsequent turns.` };
      fs.appendFileSync(path.join(this.deps.dir(s.sessionId)!, 'model-changes.jsonl'), JSON.stringify({ ...event, sessionId: s.sessionId, runtime: a.runtime }) + '\n', { mode: 0o600 });
      /*
       * Un relanzamiento tiene que resumir ESTE hilo con el modelo confirmado.
       *
       * Que un cambio de modelo tenga que acordarse de actualizar la identidad
       * es parte de lo que la partía en dos: ahora hay un solo archivo que
       * corregir, y `handoffModel` conserva con cuál nació la sesión, que es lo
       * que el acta del traspaso publica.
       */
      try {
        const dir = this.deps.dir(s.sessionId);
        const active = dir ? peekIdentity(dir) : null;
        if (dir && active?.sessionId === s.sessionId) {
          writeIdentity(dir, { ...active, handoffModel: active.handoffModel ?? active.model, model: choice.id });
        }
      } catch { /* la identidad se corrige sola al adoptar; un cambio de modelo no falla por esto */ }
      s.active = choice.id; s.requested = null; s.phase = 'ready'; s.detail = event.text;
      s.events = [...s.events, event].slice(-50); this.save(s);
    } catch (e) {
      if (menuOpen) { try { await this.keys(a, ['Escape']); } catch {} }
      s.phase = 'failed'; s.detail = e instanceof Error ? e.message : String(e);
      try { this.save(s); } catch { this.states.set(s.sessionId, structuredClone(s)); }
    }
  }
}
