import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentHandle, CommandDeps } from './commands.ts';
import { paneEnv } from './commands.ts';
import { ProviderHandoffs, prepareProvider, providerModels } from './provider-handoff.ts';
import { ModelController, resumedPromptReady } from './model-control.ts';
import { runtimeBin } from './runtime.ts';
import { paneName } from './tmux.ts';
import { orcaDir, sleep } from './util.ts';
import type { ProviderHandoffPlan } from '../shared/provider-handoff.ts';
import { parseContinuation, type Continuation } from '../shared/continuation.ts';

/** Worker preparation is isolated from CAPCOM's control files and archives. */
export class WorkerHandoffs {
  readonly handoffs: ProviderHandoffs;
  private records: Record<string, Continuation & { phase?: 'staged' | 'active'; source?: AgentHandle }> = {};
  private activating = new Set<string>();
  private reconciling = false;
  private file: string;
  constructor(private deps: CommandDeps, models: ModelController, busy: (id: string) => boolean, dir = path.join(orcaDir(), 'worker-recovery'), private options: { bin?: typeof runtimeBin; wait?: typeof sleep; prepare?: typeof prepareProvider; models?: typeof providerModels } = {}) {
    this.file = path.join(dir, 'continuations.json');
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, value] of Object.entries(saved)) { const c = parseContinuation(value); if (!c) throw new Error('Invalid worker continuation record'); this.records[id] = { ...c, phase: (value as any).phase ?? 'active', source: (value as any).source }; }
    }
    this.handoffs = new ProviderHandoffs({
      models: options.models, prepare: options.prepare,
      dir: () => dir, agent: deps.agent,
      owns: a => !a.subagent && !!a.pane && !(deps.capcom?.owns(a.sessionId) || deps.capcom?.owns(a.shortId)) && !Object.values(this.records).some(c => c.fromId === a.id && c.phase === 'active'),
      model: a => models.state(a)?.active ?? a.model ?? null,
      cwd: a => this.cwd(a),
      priorHistory: a => { const c = this.records[a.id]; try { return c ? fs.readFileSync(c.historyPath, 'utf8') : ''; } catch { return ''; } },
      busy: id => busy(id) || models.locked(id) || ['queued', 'applying'].includes(models.state(deps.agent(id)!)?.phase ?? ''),
      completed: planId => Object.entries(this.records).find(([, c]) => c.phase === 'active' && path.basename(c.archive) === planId)?.[0],
      context: a => JSON.stringify({ mission: a.mission, projectId: a.projectId, cwd: this.cwd(a), worktree: a.worktree, parentId: a.parentId, squad: a.squad, lead: a.lead }) + '\nPreserve mission, project, worktree, supervisor and task ownership. Resume only unfinished work; inspect files and tool results before retrying side effects.',
      hold: () => {}, // Commands to the source are locked by CommandRunner.
      activate: (p, id) => this.activate(p, id),
    });
  }
  continuation(id: string) { const c = this.records[id]; return c?.phase === 'active' ? parseContinuation(c) : undefined; }
  snapshotState(id: string) {
    const replaced = Object.values(this.records).some(c => c.phase === 'active' && c.fromId === id);
    return { continuation: this.continuation(id), ...(replaced ? { state: 'done' as const, block: null, pane: false } : {}) };
  }
  async reconcile() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      for (const [id, c] of Object.entries(this.records)) {
        if (c.phase !== 'staged' || this.activating.has(id) || !c.source?.pane) continue;
        const destination = await this.deps.tmux.capture(paneName(id)!, 40);
        if (!destination.ok) continue;
        const source = await this.deps.tmux.capture(c.source.pane, 40);
        if (source.ok) {
          const killed = await this.deps.tmux.kill(paneName(id)!);
          if (!killed.ok) continue;
          delete this.records[id]; this.save();
        } else {
          this.deps.lineage.replaceSession(c.fromId, id, c.source);
          c.phase = 'active'; this.save(); this.deps.onResync();
        }
      }
    } finally { this.reconciling = false; }
  }
  private cwd(a: AgentHandle) {
    const cwd = a.worktree?.path ?? a.cwd ?? this.deps.projects.get(a.projectId)?.path;
    if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Worker working directory unavailable');
    return cwd;
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.records), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
  }
  async activate(p: ProviderHandoffPlan, id: string) {
    const a = this.deps.agent(p.fromId); const name = paneName(id); const bin = (this.options.bin ?? runtimeBin)(p.runtime);
    if (!a?.pane || !a.alive || a.subagent || !name || !bin) throw new Error('Source or destination unavailable');
    const cwd = this.cwd(a);
    if (p.cwd !== cwd) throw new Error('Worker directory changed after preparation');
    const env = { ...paneEnv(this.deps.keys.materialize(a.projectId, a.parentId ?? 'orca')), ORCA_PARENT_ID: a.parentId ?? '', ORCA_PANE: name };
    // Normal project permissions remain in effect. Never grant CAPCOM's fleet credentials here.
    const args = p.runtime === 'claude' ? ['--resume', id, '--model', p.model, '--tools', 'default']
      : ['resume', id, '-C', cwd, '-m', p.model, '-s', 'workspace-write', '-a', 'on-request'];
    const started = await this.deps.tmux.spawn({ name, cwd, env, argv: [bin, ...args] });
    if (!started.ok) throw new Error(started.detail);
    let cutover = false; this.activating.add(id);
    try {
      let ready = false;
      for (let i = 0; i < 480; i++) {
        await (this.options.wait ?? sleep)(250);
        const screen = await this.deps.tmux.capture(name, 60);
        if (!screen.ok) throw new Error('Destination exited during resume');
        if (i >= 7 && resumedPromptReady(screen.stdout, p.runtime)) { ready = true; break; }
      }
      if (!ready) {
        const screen = await this.deps.tmux.capture(name, 80);
        fs.writeFileSync(path.join(p.archive, 'resume-screen.txt'), screen.stdout, { mode: 0o600 });
        throw new Error('Destination needs terminal setup. Source retained; see resume-screen.txt in the backup.');
      }
      const current = this.deps.agent(a.id);
      if (!current?.alive || !(current.state === 'idle' || (current.state === 'blocked' && current.blockKind === 'error')) || createHash('sha256').update(fs.readFileSync(a.transcriptPath!)).digest('hex') !== p.sha256) throw new Error('Source changed during resume; prepare a fresh backup');
      // Persist continuation before stopping source; rollback if it cannot stop.
      this.records[id] = { phase: 'staged', source: a, fromId: a.id, at: Date.now(), archive: p.archive, historyPath: p.historyPath, checkpointPath: p.checkpointPath };
      this.save();
      const stopped = await this.deps.tmux.kill(a.pane);
      if (!stopped.ok) throw new Error('Source could not stop; destination cancelled');
      cutover = true;
      this.deps.lineage.replaceSession(a.id, id, a);
      this.records[id]!.phase = 'active'; this.save();
      this.deps.onResync();
    } finally {
      this.activating.delete(id);
      if (!cutover) {
        await this.deps.tmux.kill(name);
        delete this.records[id]; this.save();
      }
    }
  }
}
