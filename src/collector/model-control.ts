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

/** Refuse drafts, active turns and unknown dialogs rather than type into them. */
export function modelPromptReady(screen: string, runtime: string): boolean {
  if (/esc to interrupt|Esc to interrupt|Select Model|Select model|Select Reasoning|Do you want to proceed\?|Enter to confirm/i.test(screen.slice(-3500))) return false;
  const marker = runtime === 'codex' ? '›' : '❯';
  const lines = screen.replace(/\u00a0/g, ' ').split('\n');
  const line = lines.filter(l => l.trimStart().startsWith(marker)).at(-1)?.trim().slice(1).trim();
  return line !== undefined && (line === '' || (runtime === 'codex' ? line === 'Ask Codex to do anything' : /^Try "/.test(line)));
}

/** tmux scrollback can retain the startup "model: loading" banner above the current one. */
export function resumedPromptReady(screen: string, runtime: string): boolean {
  const model = [...screen.matchAll(/model:\s+(\S+)/g)].at(-1)?.[1];
  return model !== 'loading' && modelPromptReady(screen, runtime);
}

export function modelConfirmed(screen: string, runtime: string, choice: ModelChoice): boolean {
  const lines = screen.split('\n');
  if (runtime === 'codex') return lines.some(l => l.trim().startsWith(`• Model changed to ${choice.id} `));
  const family = choice.label.split(' ')[0]!.toLowerCase();
  return lines.some(l => /Set model to .* for this session only/.test(l)
    && l.toLowerCase().includes(`set model to ${family} `));
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
  private async screen(a: AgentHandle) {
    const r = await this.deps.tmux.capture(a.pane!, 80);
    if (!r.ok) throw new Error(r.detail);
    return r.stdout;
  }
  private async keys(a: AgentHandle, keys: string[]) {
    const r = await this.deps.tmux.keys(a.pane!, keys);
    if (!r.ok) throw new Error(r.detail);
    await this.wait(180);
  }
  private async open(a: AgentHandle) {
    if (!this.idle(this.target(a.id)) || !modelPromptReady(await this.screen(a), a.runtime)) throw new Error('Clear the terminal input or finish its dialog, then try again.');
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
      let confirmed = false;
      for (let i = 0; i < 15; i++) {
        const screen = await this.screen(a);
        const count = (text: string) => text.split('\n').filter(line => modelConfirmed(line, a.runtime, choice)).length;
        if (count(screen) > count(before)) { confirmed = true; break; }
        await this.wait(150);
      }
      if (!confirmed) throw new Error('Change unconfirmed. Open the terminal to finish or inspect the CLI dialog.');
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
