import { quotaIncident } from '../../shared/recovery.ts';
import type { Agent } from '../../shared/types.ts';
import { parseModelControl, type ModelControl } from '../../shared/model-control.ts';
import type { Command } from '../../shared/protocol.ts';
import { pick, type PickHandle } from '../controls.ts';
import type { ProviderModel, ProviderHandoffPlan } from '../../shared/provider-handoff.ts';

/** Stable composer control: never replaces the operator's draft or transcript. */
export function mountCapcomModel(host: HTMLElement, command: (cmd: Command) => Promise<unknown>, terminal: (id: string) => void, file?: (path: string) => void, options?: { scope: string; openAgent(id: string): void }) {
  const storageKey = options ? `orca.agent.handoff.${options.scope}` : 'orca.capcom.handoff';
  const subject = options ? 'agent' : 'CAPCOM';
  host.className = 'capcom__model';
  host.innerHTML = '<div class="capcom__model-row"><span class="mono" data-active></span><button type="button" class="chip" data-load>CHANGE MODEL</button><button type="button" class="chip" data-capcom-new>New CAPCOM</button><div data-picker></div><button type="button" class="chip" data-cancel hidden>CANCEL CHANGE</button><button type="button" class="chip" data-terminal hidden>OPEN TERMINAL</button></div><div class="mono capcom__model-detail" role="status" aria-live="polite" data-detail></div>';
  const fresh = host.querySelector<HTMLButtonElement>('[data-capcom-new]')!;
  fresh.hidden = !!options;
  const freshChoice = document.createElement('section');
  freshChoice.className = 'capcom__transfer'; freshChoice.hidden = true;
  freshChoice.setAttribute('aria-label', 'New CAPCOM');
  freshChoice.innerHTML = '<p class="mono">New session. Keeps files, history, hub rules and workers.</p><p class="mono">Clean context: waits for new instructions, with no summary, history, automatic briefing or recall. Continuity: restores pending work with a brief checkpoint. New messages received during the change are delivered to the new CAPCOM.</p><div class="row"><span class="mono" data-fresh-model-label>Model</span><div data-fresh-model></div></div><div class="row"><button type="button" class="chip" data-fresh-clean>Clean context</button><button type="button" class="chip" data-fresh-continuity>With continuity</button><button type="button" class="chip" data-fresh-cancel>Cancel</button></div>';
  host.appendChild(freshChoice);
  const active = host.querySelector<HTMLElement>('[data-active]')!;
  const detail = host.querySelector<HTMLElement>('[data-detail]')!;
  const load = host.querySelector<HTMLButtonElement>('[data-load]')!;
  const cancel = host.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const open = host.querySelector<HTMLButtonElement>('[data-terminal]')!;
  const pickerHost = host.querySelector<HTMLElement>('[data-picker]')!;
  const review = document.createElement('section'); review.className = 'capcom__transfer'; review.hidden = true;
  review.setAttribute('aria-label', 'Provider handoff review');
  /*
   * Plegado por defecto, como el acta de traspaso: una vez leído "el contexto
   * limpio está activo", su sitio es una línea. Se abre solo cuando hay algo
   * que decidir —una revisión pendiente de confirmar— porque entonces sí es
   * una pregunta y no un recibo.
   */
  review.innerHTML = '<details class="notice__d" data-transfer-details><summary class="notice__head"><span class="notice__mark" aria-hidden="true"></span><strong class="px notice__title">PROVIDER HANDOFF</strong><span class="mono notice__sum" data-transfer-sum></span></summary><div class="notice__body"><p class="mono" data-transfer-text></p><div class="row"><button class="chip" type="button" data-checkpoint>REVIEW CONTEXT</button><button class="chip" type="button" data-history>REVIEW HISTORY</button><button class="chip" type="button" data-confirm>CONFIRM HANDOFF</button><button class="chip" type="button" data-dismiss>CANCEL</button></div></div></details>';
  host.appendChild(review);
  // Fuera del plegado a propósito: es la acción que sigue a un traspaso
  // completo —ir al agente que continúa—, y un recibo se pliega con ella a la
  // vista. Lo que se esconde es el texto, no lo que hay que poder pulsar.
  const continued = document.createElement('button'); continued.type = 'button'; continued.className = 'chip capcom__transfer-go'; continued.textContent = 'OPEN CONTINUED AGENT'; continued.hidden = true;
  review.appendChild(continued);
  continued.addEventListener('click', () => { if (plan?.toId) options?.openAgent(plan.toId); });
  const transferText = review.querySelector<HTMLElement>('[data-transfer-text]')!;
  const transferSum = review.querySelector<HTMLElement>('[data-transfer-sum]')!;
  const transferDetails = review.querySelector<HTMLDetailsElement>('[data-transfer-details]')!;
  /** Plan y fase mostrados: plegar o abrir se decide una vez por cada cambio. */
  let shownPlan = '';
  const confirm = review.querySelector<HTMLButtonElement>('[data-confirm]')!;
  const dismiss = review.querySelector<HTMLButtonElement>('[data-dismiss]')!;
  let plan: ProviderHandoffPlan | undefined;
  let poll: number | undefined;
  let restore: { id: string; agentId: string } | null = null;
  let restoring = false;
  let agent: Agent | undefined;
  let state: ModelControl | undefined;
  let busy = false;
  let error = '';
  let catalogError = '';
  let picker: PickHandle | undefined;
  let connected = false;
  let disposed = false;
  function paint() {
    host.hidden = !agent || !['codex', 'claude'].includes(agent.runtime) || (!!options && (!agent.pane || !!agent.subagent));
    active.textContent = `${agent?.runtime === 'codex' ? 'CODEX' : 'CLAUDE'} · ${state?.active ?? agent?.model ?? 'model unknown'}`;
    const pending = state?.phase === 'queued' || state?.phase === 'applying' || plan?.phase === 'preparing';
    load.disabled = busy || !!pending || !connected;
    fresh.disabled = busy || !!pending || !connected || !agent?.pane || !(agent.state === 'idle' || (agent.state === 'blocked' && agent.block?.kind === 'error'));
    fresh.title = fresh.disabled ? 'Wait until CAPCOM is connected and finishes its current turn.' : 'Create a new session with the same provider and model';
    freshChoice.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = busy || !!pending || !connected; });
    load.textContent = busy ? 'LOADING…' : catalogError ? 'RETRY MODELS' : 'CHANGE MODEL';
    cancel.hidden = state?.phase !== 'queued'; cancel.disabled = busy || !connected;
    open.hidden = !error && state?.phase !== 'failed';
    detail.textContent = error || [pending ? `${state?.requested} · ${state?.detail}` : state?.detail ?? 'Same provider · keeps this conversation', catalogError].filter(Boolean).join(' ');
    review.hidden = !plan;
    continued.hidden = !options || plan?.phase !== 'complete' || !plan.toId;
    if (plan) {
      review.querySelector('strong')!.textContent = plan.contextMode ? (plan.contextMode === 'clean' ? 'CAPCOM · CLEAN CONTEXT' : 'CAPCOM · CONTINUITY') : 'PROVIDER HANDOFF';
      /*
       * Se pliega lo único que no pide nada: el recibo de algo que salió bien.
       * Una revisión espera confirmación, una preparación está en marcha y un
       * fallo hay que leerlo —dice qué se conservó y si se puede reintentar—,
       * así que esos se abren. Va por fase y no sólo por plan, porque el paso
       * de `preparing` a `complete` es justo cuando deja de merecer la ventana.
       * Abrirlo o cerrarlo a mano se respeta hasta el siguiente cambio de fase.
       */
      const at = `${plan.id}:${plan.phase}`;
      if (at !== shownPlan) {
        shownPlan = at;
        transferDetails.open = plan.phase !== 'complete';
      }
      transferSum.textContent = `${plan.runtime}/${plan.model} · ${plan.phase}`;
      transferText.textContent = `${plan.fromRuntime}/${plan.fromModel ?? 'current model'} → ${plan.runtime}/${plan.model}. ${plan.phase === 'review' ? 'Sends the saved conversation and pending-work checkpoint to a new session. Current session stays until the destination confirms. Model context limits apply.' : plan.detail} Backup: ${(plan.bytes / 1024).toFixed(0)} KB.`;
      confirm.hidden = plan.phase !== 'review'; confirm.disabled = busy || !connected;
      dismiss.hidden = plan.phase === 'preparing'; dismiss.textContent = plan.phase === 'review' ? 'CANCEL' : 'CLOSE';
      if (plan.phase === 'preparing') detail.textContent = plan.contextMode === 'clean' ? 'CAPCOM · preparing clean context' : `HANDOFF IN PROGRESS · ${subject} is preparing a continuation`;
    }
  }
  async function newCapcom(mode: 'clean' | 'continuity') {
    if (!agent || fresh.disabled || options) return;
    const id = agent.id;
    const model = freshModel;
    busy = true; error = ''; freshChoice.hidden = true; paint();
    try {
      plan = await command({ k: 'capcom:new', agentId: id, mode, ...(model ? { model } : {}) }) as ProviderHandoffPlan;
      localStorage.setItem(storageKey, JSON.stringify({ id: plan.id, agentId: id }));
      window.clearTimeout(poll);
      poll = window.setTimeout(() => { void check(); }, 1500);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; if (!disposed) paint(); }
  }
  /**
   * Con qué modelo nace el relevo. Vacío = el que ya corre.
   *
   * Elegirlo aquí evita el paso que antes hacían dos operaciones seguidas —
   * cambiar el modelo y luego vaciar—: el collector lo aplica con el selector
   * nativo mientras el contexto viejo sigue en pie, así que un modelo sin cuota
   * falla sin haber tocado nada.
   */
  let freshModel = '';
  const freshModelHost = freshChoice.querySelector<HTMLElement>('[data-fresh-model]')!;
  let freshPicker: PickHandle | undefined;
  function paintFreshModel() {
    const choices = state?.choices ?? [];
    const active = state?.active ?? agent?.model ?? '';
    const sig = JSON.stringify([choices.map(c => c.id), active, freshModel]);
    if (sig === freshModelSig || freshPicker?.isOpen()) return;
    freshModelSig = sig;
    freshPicker?.dispose();
    if (!choices.length) {
      // Nunca una lista inventada: o la dio el CLI, o se dice por qué no.
      freshModelHost.textContent = freshLoading ? 'Loading models…'
        : freshModelError ? `${active || 'current model'} · ${freshModelError}`
        : active ? `${active} · asking the CLI for the rest…` : '';
      return;
    }
    freshPicker = pick({ name: 'capcom-fresh-model', value: freshModel || active, search: choices.length > 6,
      options: choices.map(c => ({ value: c.id, label: c.label, hint: c.id === active ? 'current' : '' })),
      onChange: id => { freshModel = id === active ? '' : id; freshModelSig = ''; paintFreshModel(); } });
    freshModelHost.replaceChildren(freshPicker.el);
  }
  let freshModelSig = '';
  let freshLoading = false;
  let freshModelError = '';
  fresh.addEventListener('click', () => {
    freshChoice.hidden = !freshChoice.hidden;
    if (freshChoice.hidden) return;
    freshModel = ''; freshModelSig = ''; paintFreshModel();
    // El catálogo lo llena el CLI cuando se le pregunta, y hasta entonces no
    // hay lista que ofrecer. Preguntarlo aquí es lo que hace que la elección
    // exista: dejarlo para el botón de al lado la escondía a quien no supiera
    // que había que pulsarlo primero.
    if (!(state?.choices ?? []).length) void loadFreshModels();
  });

  /** Sólo el catálogo nativo: aquí no se cambia de proveedor. */
  async function loadFreshModels() {
    const id = agent?.id;
    if (!id || busy || freshLoading) return;
    freshLoading = true; freshModelSig = ''; paintFreshModel();
    try {
      const native = parseModelControl(await command({ k: 'model:list', agentId: id }));
      if (disposed || agent?.id !== id) return;
      if (native) state = native;
    } catch (e) {
      if (agent?.id === id) freshModelError = e instanceof Error ? e.message : String(e);
    } finally { freshLoading = false; freshModelSig = ''; if (!disposed) paintFreshModel(); }
  }
  freshChoice.querySelector('[data-fresh-clean]')!.addEventListener('click', () => { void newCapcom('clean'); });
  freshChoice.querySelector('[data-fresh-continuity]')!.addEventListener('click', () => { void newCapcom('continuity'); });
  freshChoice.querySelector('[data-fresh-cancel]')!.addEventListener('click', () => { freshChoice.hidden = true; });
  const requestedFresh = (event: Event) => {
    if (options || disposed) return;
    const mode = (event as CustomEvent).detail;
    if (fresh.disabled) { error = 'New CAPCOM requires a connected, hosted and idle command session. Wait until its current turn finishes.'; paint(); return; }
    if (mode === 'clean' || mode === 'continuity') void newCapcom(mode);
    else freshChoice.hidden = false;
  };
  if (!options) window.addEventListener('orca:capcom-new', requestedFresh);
  async function prepare(runtime: string, model: string) {
    const id = agent?.id; if (!id) return;
    busy = true; error = ''; paint();
    try { const result = await command({ k: 'handoff:prepare', agentId: id, runtime, model }) as ProviderHandoffPlan;
      if (!disposed && agent?.id === id) { plan = result; picker?.dispose(); picker = undefined; pickerHost.replaceChildren(); }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; if (!disposed) paint(); }
  }
  async function check() {
    if (!plan || disposed) return;
    try { plan = await command({ k: 'handoff:status', agentId: agent?.id ?? plan.fromId, planId: plan.id }) as ProviderHandoffPlan; }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    if (disposed) return;
    paint();
    if (plan?.phase === 'preparing') poll = window.setTimeout(() => { void check(); }, 2000);
  }
  confirm.addEventListener('click', async () => {
    if (!plan || !agent) return;
    busy = true; error = ''; paint();
    try {
      const incident = options && quotaIncident(agent);
      if (incident) {
        const decision = await command({ k: 'recovery:decide', agentId: agent.id, decision: { action: 'handoff', incident: incident.id, runtime: plan.runtime, model: plan.model, planId: plan.id, reason: 'Operator confirmed the reviewed provider handoff after a usage limit.' } }) as { phase: string; detail: string };
        if (decision.phase === 'failed') throw new Error(decision.detail);
        plan = await command({ k: 'handoff:status', agentId: agent.id, planId: plan.id }) as ProviderHandoffPlan;
      } else plan = await command({ k: 'handoff:commit', agentId: agent.id, planId: plan.id }) as ProviderHandoffPlan;
      localStorage.setItem(storageKey, JSON.stringify({ id: plan.id, agentId: plan.fromId }));
      poll = window.setTimeout(() => { void check(); }, 1500);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; if (!disposed) paint(); }
  });
  dismiss.addEventListener('click', () => { plan = undefined; localStorage.removeItem(storageKey); paint(); });
  review.querySelector('[data-checkpoint]')!.addEventListener('click', () => { if (plan) file?.(plan.checkpointPath); });
  review.querySelector('[data-history]')!.addEventListener('click', () => { if (plan) file?.(plan.historyPath); });
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved?.id && saved?.agentId) restore = saved;
  } catch {}
  async function request(model: string | null) {
    const id = agent?.id;
    if (!id) return;
    if (plan?.phase === 'review') plan = undefined;
    busy = true; error = ''; paint();
    try {
      const incident = options && agent && quotaIncident(agent);
      let result: ModelControl;
      if (incident && model) {
        const decision = await command({ k: 'recovery:decide', agentId: id, decision: { action: 'model', incident: incident.id, model, reason: 'Operator selected this model to continue after a usage limit.' } }) as { phase: string; detail: string };
        if (decision.phase === 'failed') throw new Error(decision.detail);
        result = await command({ k: 'model:list', agentId: id }) as ModelControl;
      } else result = await command({ k: 'model:set', agentId: id, model }) as ModelControl;
      if (disposed || agent?.id !== id) return;
      state = result;
      picker?.dispose(); picker = undefined; pickerHost.replaceChildren();
    } catch (e) { if (agent?.id === id) error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; if (!disposed) paint(); }
  }
  load.addEventListener('click', async () => {
    const id = agent?.id;
    if (!id || busy) return;
    busy = true; error = ''; catalogError = '';
    picker?.dispose(); picker = undefined; pickerHost.replaceChildren(); paint();
    try {
      const [native, providers] = await Promise.allSettled([command({ k: 'model:list', agentId: id }), command({ k: 'handoff:models', agentId: id })]);
      if (disposed || agent?.id !== id) return;
      const issues: string[] = [];
      const reason = (e: unknown) => e instanceof Error ? e.message : String(e);
      const current = native.status === 'fulfilled' ? parseModelControl(native.value) : undefined;
      const validNative = current?.runtime === agent!.runtime ? current : undefined;
      if (validNative) state = validNative;
      else issues.push(`${agent!.runtime.toUpperCase()} session catalog: ${native.status === 'rejected' ? reason(native.reason) : 'invalid response'}.`);
      const validProviders = providers.status === 'fulfilled' && Array.isArray(providers.value) && providers.value.every(p => p && ['claude', 'codex'].includes(p.runtime) && typeof p.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(p.id) && typeof p.label === 'string' && typeof p.installed === 'boolean');
      const catalog: ProviderModel[] = validProviders ? providers.value as ProviderModel[] : [];
      if (!validProviders) issues.push(`Provider catalog: ${providers.status === 'rejected' ? reason(providers.reason) : 'invalid response'}.`);
      const choices = validNative?.choices ?? [];
      const unverified = catalog.filter(p => p.runtime === agent!.runtime && !choices.some(c => c.id === p.id));
      const alternatives = catalog.filter(p => p.runtime !== agent!.runtime);
      if (validNative && !choices.length) issues.push(`${agent!.runtime.toUpperCase()} session catalog is not ready. Retry when ${subject} is idle and its terminal prompt is clear.`);
      else if (unverified.length) issues.push('Some discovered models are not confirmed by this session. Retry when its terminal prompt is clear.');
      if (validProviders && !catalog.some(p => p.runtime === 'codex')) issues.push('Codex discovery returned no models. Retry after its local catalog is available.');
      catalogError = issues.join(' ');
      if (state?.phase === 'applying' || state?.phase === 'queued') return;
      if (!choices.length && !catalog.length) { catalogError ||= `No model catalog available. Retry when ${subject} is idle.`; return; }
      picker = pick({ name: 'capcom-model', value: state?.active ?? '', placeholder: 'Choose model', search: true,
        options: [...choices.map(c => ({ value: c.id, label: c.label, group: agent!.runtime.toUpperCase(), hint: c.id === state?.active ? 'active' : 'same session' })),
          ...unverified.map(p => ({ value: p.id, label: p.label, group: agent!.runtime.toUpperCase(), hint: 'session catalog not ready · retry', disabled: true })),
          ...alternatives.map(p => ({ value: `${p.runtime}:${p.id}`, label: p.label, group: p.runtime === 'claude' ? 'CLAUDE CODE' : 'CODEX', hint: p.installed ? 'handoff · review first' : 'CLI not installed', disabled: !p.installed }))],
        onChange: model => { if (model.includes(':')) { const [runtime, id] = model.split(':'); void prepare(runtime!, id!); } else void request(model); } });
      pickerHost.replaceChildren(picker.el);
      // Open after the originating click has finished bubbling to document.
      window.setTimeout(() => { if (!disposed && agent?.id === id) picker?.el.querySelector<HTMLButtonElement>('button')?.click(); }, 0);
    } catch (e) { if (agent?.id === id) error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; if (!disposed) paint(); }
  });
  cancel.addEventListener('click', () => { void request(null); });
  open.addEventListener('click', () => { if (agent) terminal(agent.id); });
  return {
    update(next: Agent | undefined, link: boolean) {
      if (agent?.id !== next?.id) { state = undefined; error = ''; catalogError = ''; picker?.dispose(); picker = undefined; pickerHost.replaceChildren(); }
      agent = next; connected = link;
      if (restore && connected && agent && !restoring) {
        restoring = true;
        void command({ k: 'handoff:status', agentId: agent.id, planId: restore.id }).then(result => {
          if (disposed) return; restore = null; plan = result as ProviderHandoffPlan; paint(); if (plan.phase === 'preparing') void check();
        }).catch(e => { error = e instanceof Error ? e.message : String(e); restore = null; }).finally(() => { restoring = false; });
      }
      if (!busy && next?.modelControl) state = next.modelControl;
      paint();
    },
    dispose() { window.removeEventListener('orca:capcom-new', requestedFresh); disposed = true; window.clearTimeout(poll); picker?.dispose(); freshPicker?.dispose(); },
  };
}
