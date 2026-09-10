/**
 * An interrupt: one question that needs a person.
 *
 * It opens itself, anchored to the tile that raised it, and closes itself
 * when the question is answered or withdrawn — from here, from the agent's
 * window, or by the CEO.
 *
 * Answering is the one microinteraction an operator sees a hundred times a
 * day, so it gets the comp's lime sweep (A5, `windows/fx.ts`): the answer goes
 * out, the body fills lime left to right, and the window leaves confirmed
 * instead of just disappearing. Nothing to wire — it happens inside.
 */

import type { Escalation } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { hub } from '../../net/client.ts';
import { bindComposer, composerHint } from '../composer.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { ago, esc } from '../../util.ts';
import { fold, toggle, type ToggleHandle } from '../../controls.ts';
import { slabFlash } from '../fx.ts';

export function mountInterrupt(ctx: WinCtx, c: Console) {
  const id = ctx.win.spec.params?.escalationId ?? '';
  const body = ctx.body;
  ctx.setState('blocked', 'var(--amber)');
  let sig = '';
  /**
   * Set the instant an answer leaves. The store echoes the answer back within
   * the same tick (main.ts marks the escalation answered), and without this
   * the next render would drop the window on the floor mid-sweep.
   */
  let confirming = false;
  /** The REMEMBER switch of the current render; read when an answer leaves. */
  let remembering: ToggleHandle | null = null;

  /**
   * Answer, then leave through the lime bar. A5.
   *
   * §6.2 first: the slab that took the answer inverts to ink for a frame, so
   * the operator sees *which* option they hit before the whole body turns lime
   * under it. The two gestures are one beat apart, not on top of each other.
   */
  function answerAndSweep(escalationId: string, answer: string, rememberAs: string | null, btn?: HTMLElement | null) {
    if (confirming) return;
    if (esca()?.permission) { c.answer(escalationId, answer, null); sig = ''; render(); return; }
    confirming = true;
    slabFlash(btn);
    c.answer(escalationId, answer, rememberAs);
    void c.wm.closeWith(ctx.win, 'wipe');
  }

  function esca(): Escalation | undefined { return store.world.escalations[id]; }

  function render() {
    const e = esca();
    if (confirming) return;
    if (!e || (e.status !== 'pending' && e.status !== 'with_ceo')) { ctx.close(); return; }
    const a = store.world.agents[e.agentId];
    const p = store.world.projects[e.projectId];
    ctx.setCallsign(a?.callsign ?? '??', p?.code);
    ctx.setTitle(a?.title ?? '');
    const now = Date.now();
    const unblocks = 1 + store.dammedBehind(e.agentId).length;
    /*
     * Del arnés: la pregunta la inventó una máquina de fixture y la respuesta
     * no le llega a nadie —el hub la tiene en cuarentena (`shared/synthetic.ts`)—.
     * La ventana se abre igual si la abres tú, y lo dice en la primera línea,
     * antes de la pregunta, porque una fixture bien escrita se lee como real.
     */
    const fake = store.fromHarness(e);
    const s = [e.status, e.permission?.phase, e.ceoAttempt?.answer, Math.floor(now / 10000), unblocks, fake].join('|');
    if (s === sig) return;
    sig = s;

    body.innerHTML = `
      <div class="win__scroll scroll">
        <div class="block${fake ? ' block--harness' : ''}" style="margin:10px 10px 6px">
          <div class="block__k"><span>${fake ? 'HARNESS · ' : ''}${e.permission?.phase === 'pending' ? 'RESPONSE PENDING · ' : ''}${e.urgency === 'blocking' ? 'BLOCKING' : e.urgency.toUpperCase()} · ${ago(e.askedAt, now)}${e.status === 'with_ceo' ? ' · CAPCOM LOOKING' : ''}</span><span>UNBLOCKS ${unblocks}</span></div>
          <div class="block__q mono">${esc(e.question)}</div>
          ${e.context ? `<div data-context style="margin-top:6px"></div>` : ''}
          ${e.ceoAttempt ? `<div class="block__tried mono"><b>CAPCOM TRIED · ${Math.round(e.ceoAttempt.confidence * 100)}%</b>${esc(e.ceoAttempt.answer)}<br/><span style="color:var(--ink-dimmer)">punted: ${esc(e.ceoAttempt.reason)}</span></div>` : ''}
          <div class="block__opts">${e.options.slice(0, 9).map((o, i) => `<button class="slab-btn slab-btn--amber slab-btn--sm" type="button" data-opt="${esc(o)}" data-key="${i + 1}">${esc(o)}</button>`).join('')}${e.options.slice(9).map((o) => `<button class="slab-btn slab-btn--amber slab-btn--sm" type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
          ${e.optionsOnly ? '' : `<div class="row" style="margin-top:8px"><textarea class="input" rows="2" data-ans aria-label="Answer" placeholder="${esc(composerHint('type an answer'))}"></textarea><button class="slab-btn slab-btn--amber slab-btn--sm slab-btn--fit" type="button" data-send>SEND</button></div>`}
          <div data-remember style="margin-top:8px"></div>
        </div>
        <div class="row row--split" style="padding:4px 10px 10px">
          <button class="btn" type="button" data-open data-key="o">OPEN AGENT</button>
          <button class="btn" type="button" data-dismiss data-key="d">DISMISS</button>
        </div>
      </div>
    `;
    const ctxHost = body.querySelector<HTMLElement>('[data-context]');
    if (ctxHost && e.context) {
      const inner = document.createElement('div');
      inner.className = 'mono';
      inner.style.color = 'var(--ink-dim)';
      inner.textContent = e.context;
      ctxHost.appendChild(fold({ label: 'CONTEXT', body: inner }));
    }
    remembering?.dispose();
    remembering = toggle({ name: 'remember', label: 'REMEMBER · LET CAPCOM ANSWER THIS NEXT TIME' });
    body.querySelector<HTMLElement>('[data-remember]')!.appendChild(remembering.el);
    if (e.permission) { remembering.el.hidden = true; if (e.permission.phase === 'pending') body.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach(b => { b.disabled = true; }); }
    const remember = () => (remembering?.checked() ? e.question : null);
    body.querySelectorAll<HTMLElement>('[data-opt]').forEach((b) => b.addEventListener('click', () => answerAndSweep(e.id, b.dataset.opt!, remember(), b)));
    const ans = body.querySelector<HTMLTextAreaElement>('[data-ans]');
    const sendBtn = body.querySelector<HTMLElement>('[data-send]');
    const send = () => { const v = ans?.value.trim(); if (v) { answerAndSweep(e.id, v, remember(), sendBtn); } };
    sendBtn?.addEventListener('click', send);
    // Una respuesta puede ser de varias líneas: Enter salta, ⌘/⌃Enter manda.
    if (ans) bindComposer(ans, send);
    body.querySelector('[data-open]')!.addEventListener('click', () => c.openAgent(e.agentId));
    body.querySelector('[data-dismiss]')!.addEventListener('click', () => { hub.dismiss(e.id); ctx.close(); });
    if (ans && !ctx.win.spec.params?.quiet) setTimeout(() => ans.focus(), 60);
  }

  const off = store.on((ev) => { if (ev.k === 'world' || ev.k === 'escalations' || ev.k === 'agents') render(); });
  const tick = window.setInterval(render, 5000);
  render();
  return { dispose() { off(); clearInterval(tick); remembering?.dispose(); } };
}
