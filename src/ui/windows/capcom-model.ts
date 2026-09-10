import { quotaIncident } from '../../shared/recovery.ts';
import type { Agent } from '../../shared/types.ts';
import { parseModelControl, type ModelControl } from '../../shared/model-control.ts';
import type { Command } from '../../shared/protocol.ts';
import { pick, type PickHandle } from '../controls.ts';
import { markForRuntime, markSVG } from '../gfx/marks.ts';
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
  freshChoice.innerHTML = '<p class="mono">New session. Keeps files, history, hub rules and workers.</p><p class="mono">Clean context: waits for new instructions, with no summary, history, automatic briefing or recall. Continuity: restores pending work with a brief checkpoint. New messages received during the change are delivered to the new CAPCOM.</p><div class="row"><span class="mono" data-fresh-model-label>Model</span><div data-fresh-model></div></div><p class="mono" data-fresh-note hidden></p><div class="row"><button type="button" class="chip" data-fresh-clean>Clean context</button><button type="button" class="chip" data-fresh-continuity>With continuity</button><button type="button" class="chip" data-fresh-cancel>Cancel</button></div>';
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
    /*
     * La misma marca que la lista, en la línea que se ve con el menú CERRADO.
     * Dentro del selector la marca separa dos bloques; aquí dice de quién es el
     * modelo que está corriendo AHORA, que es lo que el operador mira antes de
     * abrir nada. El nombre del runtime sigue escrito al lado: la marca
     * acompaña al texto, no lo sustituye —un dibujo de 18px no es un nombre.
     */
    const runtime = agent?.runtime === 'codex' ? 'codex' : 'claude';
    active.textContent = '';
    const amark = markSVG(markForRuntime(runtime));
    if (amark) active.insertAdjacentHTML('beforeend', amark);
    active.insertAdjacentText('beforeend',
      `${runtime.toUpperCase()} · ${state?.active ?? agent?.model ?? 'model unknown'}`);
    active.classList.toggle('has-mark', !!amark);
    const pending = state?.phase === 'queued' || state?.phase === 'applying' || plan?.phase === 'preparing';
    load.disabled = busy || !!pending || !connected;
    fresh.disabled = busy || !!pending || !connected || !agent?.pane || !(agent.state === 'idle' || (agent.state === 'blocked' && agent.block?.kind === 'error'));
    fresh.title = fresh.disabled ? 'Wait until CAPCOM is connected and finishes its current turn.' : 'Create a new session with the same provider and model';
    freshChoice.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = busy || !!pending || !connected; });
    load.textContent = busy ? 'LOADING…' : catalogError ? 'RETRY MODELS' : 'CHANGE MODEL';
    cancel.hidden = state?.phase !== 'queued'; cancel.disabled = busy || !connected;
    open.hidden = !error && state?.phase !== 'failed';
    detail.textContent = error || [resetNote || (pending ? `${state?.requested} · ${state?.detail}` : state?.detail ?? 'Same provider · keeps this conversation'), catalogError].filter(Boolean).join(' ');
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
  /**
   * Lo que dice el vaciado en el sitio, que no tiene plan que enseñar.
   *
   * `capcom:new` contesta dos cosas distintas según por dónde vaya: cruzar de
   * proveedor devuelve un plan de traspaso —con archivo, hashes y fases—, y
   * quedarse en el mismo devuelve el recibo de un `/clear`, que no tiene nada
   * de eso. Darlo por plan pintaba `undefined/undefined` y `NaN KB`, y además
   * preguntaba por un traspaso con id vacío, que el collector rechaza con
   * «Invalid handoff id». El acta duradera la publica el mundo (SESSION
   * CHANGED); aquí sólo hace falta decir qué está pasando y cómo acabó.
   */
  let resetNote = '';
  /** ¿Hay un cambio de CAPCOM en marcha, y en qué anda? */
  let moving: string | null = null;
  /** ¿Vino un plan de traspaso, o el recibo de un vaciado en el sitio? */
  function isPlan(v: unknown): v is ProviderHandoffPlan {
    const p = v as Partial<ProviderHandoffPlan> | null;
    return !!p && typeof p.id === 'string' && typeof p.phase === 'string' && typeof p.runtime === 'string';
  }
  async function newCapcom(mode: 'clean' | 'continuity') {
    if (!agent || fresh.disabled || options) return;
    const id = agent.id;
    const model = freshModel;
    busy = true; error = ''; freshChoice.hidden = true;
    resetNote = `CAPCOM · ${mode === 'clean' ? 'clearing context' : 'clearing context with continuity'}…`;
    moving = mode === 'clean' ? 'clearing context' : 'clearing context · continuity';
    paint();
    try {
      const result = await command({ k: 'capcom:new', agentId: id, mode, ...(model ? { model } : {}) });
      if (isPlan(result)) {
        resetNote = ''; moving = null; plan = result;
        localStorage.setItem(storageKey, JSON.stringify({ id: plan.id, agentId: id }));
        window.clearTimeout(poll);
        poll = window.setTimeout(() => { void check(); }, 1500);
      } else {
        // Vaciado en el sitio: no hay nada que seguir ni que confirmar.
        plan = undefined; localStorage.removeItem(storageKey);
        const to = (result as { toId?: unknown } | null)?.toId;
        resetNote = `CAPCOM · ${mode === 'clean' ? 'clean context' : 'continuity'} active${typeof to === 'string' ? ` · ${to.slice(0, 8)}` : ''}`;
      }
    } catch (e) { resetNote = ''; error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; moving = null; if (!disposed) paint(); }
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
  /** Los modelos de TODOS los proveedores, para poder ofrecer el otro camino. */
  let freshCatalog: ProviderModel[] = [];
  const freshModelHost = freshChoice.querySelector<HTMLElement>('[data-fresh-model]')!;
  const freshNote = freshChoice.querySelector<HTMLElement>('[data-fresh-note]')!;
  const freshClean = freshChoice.querySelector<HTMLButtonElement>('[data-fresh-clean]')!;
  const freshCont = freshChoice.querySelector<HTMLButtonElement>('[data-fresh-continuity]')!;
  let freshPicker: PickHandle | undefined;
  /** ¿El modelo elegido cruza de proveedor? Decide el mecanismo y lo que se dice. */
  function freshCrosses(): boolean {
    return !!freshModel && !!agent && (freshCatalog.find(m => m.id === freshModel)?.runtime ?? agent.runtime) !== agent.runtime;
  }
  function paintFreshModel() {
    const choices = state?.choices ?? [];
    const active = state?.active ?? agent?.model ?? '';
    const others = agent ? freshCatalog.filter(m => m.runtime !== agent!.runtime) : [];
    // Antes del corte: lo que prometen los botones depende del modelo elegido,
    // no de si hay que redibujar la lista — y elegir deja el picker abierto un
    // instante, que era justo cuando el corte se comía la actualización.
    paintFreshButtons();
    const sig = JSON.stringify([choices.map(c => c.id), others.map(o => [o.id, o.installed]), active, freshModel]);
    if (sig === freshModelSig || freshPicker?.isOpen()) return;
    freshModelSig = sig;
    freshPicker?.dispose();
    /*
     * Los dos caminos en la misma lista, y dicho cuál es cuál.
     *
     * Quedarse en el proveedor actual se vacía en el sitio: segundos, y no hay
     * proceso nuevo que pueda fallar. Cruzar arranca otro binario, tarda hasta
     * dos minutos y puede quedarse en la cuota o la autenticación. Es la misma
     * acción con dos perfiles muy distintos, y esconder eso detrás del mismo
     * botón es lo que hace desconfiar de una consola.
     */
    const cross = (m: ProviderModel) => ({ value: m.id, label: m.label,
      group: m.runtime === 'claude' ? 'CLAUDE CODE' : 'CODEX', mark: markForRuntime(m.runtime),
      hint: m.installed ? 'prepares and verifies · slower' : 'CLI not installed', disabled: !m.installed });
    if (!choices.length && !others.length) {
      // Nunca una lista inventada: o la dio el CLI, o se dice por qué no.
      freshModelHost.textContent = freshLoading ? 'Loading models…'
        : freshModelError ? `${active || 'current model'} · ${freshModelError}`
        : active ? `${active} · asking the CLI for the rest…` : '';
      paintFreshButtons();
      return;
    }
    freshPicker = pick({ name: 'capcom-fresh-model', value: freshModel || active, search: choices.length + others.length > 6,
      options: [...choices.map(c => ({ value: c.id, label: c.label, group: (agent?.runtime ?? '').toUpperCase(),
        mark: markForRuntime(agent?.runtime ?? ''),
        hint: c.id === active ? 'current · clears in place' : 'clears in place' })), ...others.map(cross)],
      onChange: id => { freshModel = id === active ? '' : id; freshModelSig = ''; paintFreshModel(); } });
    freshModelHost.replaceChildren(freshPicker.el);
    paintFreshButtons();
  }
  /** Lo que los botones prometen depende de por dónde va a ir. */
  function paintFreshButtons() {
    const crosses = freshCrosses();
    freshClean.textContent = crosses ? 'Clean context · prepare' : 'Clean context';
    freshCont.textContent = crosses ? 'With continuity · prepare' : 'With continuity';
    const note = crosses
      ? 'Switching provider starts a second CLI: it is prepared and verified before the current CAPCOM is retired, which takes up to two minutes and can fail on quota or authentication. The current session is kept if it does.'
      : '';
    freshNote.textContent = note; freshNote.hidden = !note;
  }
  let freshModelSig = '';
  let freshLoading = false;
  let freshModelError = '';
  fresh.addEventListener('click', () => {
    freshChoice.hidden = !freshChoice.hidden;
    if (freshChoice.hidden) return;
    resetNote = '';
    freshModel = ''; freshModelSig = ''; paintFreshModel();
    // El catálogo lo llena el CLI cuando se le pregunta, y hasta entonces no
    // hay lista que ofrecer. Preguntarlo aquí es lo que hace que la elección
    // exista: dejarlo para el botón de al lado la escondía a quien no supiera
    // que había que pulsarlo primero.
    if (!(state?.choices ?? []).length || !freshCatalog.length) void loadFreshModels();
  });

  /**
   * Los dos catálogos: el de esta sesión y el de los proveedores instalados.
   *
   * Por separado, y tolerando que uno falle: sin el nativo aún se puede cruzar
   * de proveedor, y sin el de proveedores aún se puede cambiar de modelo aquí
   * dentro. Rendir la elección entera porque una de las dos preguntas no tuvo
   * respuesta dejaría al operador sin la mitad que sí funciona.
   */
  async function loadFreshModels() {
    const id = agent?.id;
    if (!id || busy || freshLoading) return;
    freshLoading = true; freshModelError = ''; freshModelSig = ''; paintFreshModel();
    try {
      const [native, providers] = await Promise.allSettled([
        command({ k: 'model:list', agentId: id }), command({ k: 'handoff:models', agentId: id }),
      ]);
      if (disposed || agent?.id !== id) return;
      const parsed = native.status === 'fulfilled' ? parseModelControl(native.value) : undefined;
      if (parsed) state = parsed;
      if (providers.status === 'fulfilled' && Array.isArray(providers.value)) freshCatalog = providers.value as ProviderModel[];
      const failed = [native.status === 'rejected' ? 'this session' : '', providers.status === 'rejected' ? 'other providers' : ''].filter(Boolean);
      if (failed.length) freshModelError = `Could not list ${failed.join(' or ')}.`;
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
    // `/capcom-new clean` promete el mismo proveedor y modelo: una elección que
    // quedó en el panel de al lado no puede cruzar de proveedor a su espalda.
    if (mode === 'clean' || mode === 'continuity') { freshModel = ''; freshModelSig = ''; void newCapcom(mode); }
    else freshChoice.hidden = false;
  };
  if (!options) window.addEventListener('orca:capcom-new', requestedFresh);
  async function prepare(runtime: string, model: string) {
    const id = agent?.id; if (!id) return;
    busy = true; error = ''; resetNote = ''; paint();
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
    busy = true; error = ''; resetNote = ''; paint();
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
        options: [...choices.map(c => ({ value: c.id, label: c.label, group: agent!.runtime.toUpperCase(), mark: markForRuntime(agent!.runtime), hint: c.id === state?.active ? 'active' : 'same session' })),
          ...unverified.map(p => ({ value: p.id, label: p.label, group: agent!.runtime.toUpperCase(), mark: markForRuntime(agent!.runtime), hint: 'session catalog not ready · retry', disabled: true })),
          ...alternatives.map(p => ({ value: `${p.runtime}:${p.id}`, label: p.label, group: p.runtime === 'claude' ? 'CLAUDE CODE' : 'CODEX', mark: markForRuntime(p.runtime), hint: p.installed ? 'handoff · review first' : 'CLI not installed', disabled: !p.installed }))],
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
    /**
     * Qué cambio de mando está en marcha, para quien pinta la ventana.
     *
     * Un relevo tarda: vaciar en el sitio son segundos y cruzar de proveedor
     * hasta dos minutos, y durante todo ese rato la sesión que se va sigue
     * ociosa — así que la ventana anunciaba IDLE, que es cierto de la sesión y
     * falso del mando. Esto es lo único que hace falta saber fuera para que la
     * banda de actividad y el estado digan que está pasando algo.
     */
    transition(): string | null {
      if (moving) return moving;
      if (plan?.phase !== 'preparing') return null;
      return `preparing ${plan.runtime}/${plan.model}${plan.contextMode === 'clean' ? ' · clean context' : ''}`;
    },
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
