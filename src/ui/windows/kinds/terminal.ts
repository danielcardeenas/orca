/**
 * An agent's pane, live.
 *
 * Everything else in the console is derived: state, tool, cost, what it said.
 * This window is the thing itself — the CLI's own screen, streamed from the
 * tmux pane the collector keeps it in, and a keyboard that goes straight back.
 * It is where you answer a permission prompt, pick an option, type a
 * `/command`, or just watch.
 *
 * The stream is one `term:open` on the hub link; bytes come back on it and
 * keystrokes go down on it. Closing the window detaches: the pane, and the
 * agent in it, do not notice. A session that was not launched hosted has no
 * pane and says so instead of showing black.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import type { Agent } from '../../../shared/types.ts';
import { store } from '../../store.ts';
import { hub, type TermHandle } from '../../net/client.ts';
import type { Console } from '../../console.ts';
import type { WinCtx } from '../wm.ts';
import { stateVar, stateWord } from '../../util.ts';
import { getSound } from '../../hud/sound.ts';
import { findPaths } from '../paths.ts';

/** The comp's palette on the CLI's sixteen colours: lime for live, amber for waiting, red for breach. */
const THEME = {
  background: '#0b0a0d',
  foreground: '#e8e8ea',
  cursor: '#c0f94a',
  cursorAccent: '#0b0a0d',
  selectionBackground: 'rgba(192, 249, 74, 0.22)',
  selectionInactiveBackground: 'rgba(192, 249, 74, 0.12)',
  black: '#141318', brightBlack: '#4a4e48',
  red: '#ff2a12', brightRed: '#ff6a58',
  green: '#c0f94a', brightGreen: '#d8ff8a',
  yellow: '#f5a524', brightYellow: '#ffc65c',
  blue: '#6a8cff', brightBlue: '#8fb8ff',
  magenta: '#c88cff', brightMagenta: '#dcb0ff',
  cyan: '#5fd8d0', brightCyan: '#8fecE6',
  white: '#8b9088', brightWhite: '#f2f4f0',
};

export function mountTerminal(ctx: WinCtx, c: Console) {
  const id = ctx.win.spec.params?.agentId ?? '';
  const body = ctx.body;
  body.innerHTML = `
    <div class="term">
      <div class="term__host" data-host></div>
      <div class="term__note" data-note><span class="px px--tiny" data-msg>ATTACHING…</span><span data-act></span></div>
    </div>
  `;
  const root = body.querySelector<HTMLElement>('.term')!;
  const host = body.querySelector<HTMLElement>('[data-host]')!;
  const note = body.querySelector<HTMLElement>('[data-note]')!;
  const msg = body.querySelector<HTMLElement>('[data-msg]')!;
  const act = body.querySelector<HTMLElement>('[data-act]')!;

  const term = new Terminal({
    theme: THEME,
    fontFamily: '"Geist Mono", ui-monospace, Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.15,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 8000,
    allowProposedApi: true,
    allowTransparency: true,
    macOptionIsMeta: true,
    // The pane is 160×45 at birth; what the window can fit wins as soon as it attaches.
    cols: 120, rows: 36,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { term.loadAddon(new WebglAddon()); } catch { /* canvas renderer is fine */ }

  // A path on the CLI's own screen opens in ORCA's viewer too (see ../paths.ts):
  // hover underlines it, click opens, ⌘click opens another window.
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const row = term.buffer.active.getLine(y - 1);
      const text = row?.translateToString(true) ?? '';
      const a = agent();
      const found = text.includes('/') ? findPaths(text, { root: store.world.projects[a?.projectId ?? '']?.path ?? null }) : [];
      if (!found.length) { cb(undefined); return; }
      cb(found.map((m) => ({
        text: text.slice(m.start, m.end),
        range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
        activate: (e: MouseEvent) => c.openFile({ path: m.path, line: m.line, col: m.col, agentId: id }, { fresh: e.metaKey || e.ctrlKey, at: { x: e.clientX, y: e.clientY } }),
      })));
    },
  });

  let handle: TermHandle | null = null;
  let gone = false;
  let resizeTimer = 0;

  function agent(): Agent | undefined { return store.knownAgent(id); }

  function setNote(text: string, tone: 'live' | 'off' | 'dead' | null, action: { label: string; key: string; run: () => void } | null) {
    msg.textContent = text;
    note.classList.toggle('is-live', tone === 'live');
    note.classList.toggle('is-off', tone === 'off');
    note.classList.toggle('is-dead', tone === 'dead');
    act.innerHTML = action ? `<button class="btn" type="button" data-key="${action.key}">${action.label}</button>` : '';
    if (action) act.querySelector('button')!.addEventListener('click', action.run);
    root.classList.toggle('is-idle', !handle);
  }

  function attach() {
    if (handle || gone) return;
    const a = agent();
    if (!a) { setNote('THIS AGENT IS NO LONGER IN THE FLEET', 'dead', null); return; }
    if (!a.pane) {
      setNote('NO PANE · this session was not launched hosted by ORCA; it can be watched, not attached to', 'off', null);
      return;
    }
    fit.fit();
    setNote(`ATTACHING TO ${a.callsign}…`, null, null);
    handle = hub.termOpen(id, term.cols, term.rows, {
      data: (chunk) => { if (handle) term.write(chunk); },
      exit: (reason) => {
        handle = null;
        const a2 = agent();
        const dead = !a2 || a2.state === 'dead' || a2.state === 'done';
        setNote(`DETACHED · ${reason}`, dead ? 'dead' : 'off',
          dead ? null : { label: 'REATTACH', key: 'r', run: () => { term.reset(); attach(); } });
        getSound()?.play('close');
      },
    });
    setNote(`LIVE · ${a.callsign} · ${term.cols}×${term.rows}`, 'live', { label: 'DETACH', key: 'd', run: () => detach('detached') });
    getSound()?.play('open');
    window.setTimeout(() => term.focus(), 40);
  }

  function detach(reason: string) {
    if (!handle) return;
    const h = handle;
    handle = null;
    h.close();
    setNote(`DETACHED · ${reason}`, 'off', { label: 'REATTACH', key: 'r', run: () => { term.reset(); attach(); } });
  }

  term.onData((data) => handle?.input(data));
  term.onResize(({ cols, rows }) => {
    if (!handle) return;
    const a = agent();
    if (a) msg.textContent = `LIVE · ${a.callsign} · ${cols}×${rows}`;
    handle.resize(cols, rows);
  });

  const ro = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { try { fit.fit(); } catch { /* not laid out yet */ } }, 60);
  });
  ro.observe(host);

  // Clicking anywhere on the glass hands the keyboard to the pane.
  host.addEventListener('mousedown', () => { window.setTimeout(() => term.focus(), 0); });

  function render() {
    const a = agent();
    if (!a) {
      if (!gone) { gone = true; detach('the agent is gone'); ctx.setTitle('GONE'); }
      return;
    }
    const p = store.world.projects[a.projectId];
    ctx.setCallsign(a.callsign, p?.code);
    ctx.setTitle(`TERMINAL · ${stateWord(a).toUpperCase()}`);
    ctx.setState(a.state === 'blocked' ? 'blocked' : a.state === 'dead' ? 'dead' : null, stateVar(a));
    if (!handle && a.pane && !gone && note.classList.contains('is-off') && msg.textContent?.startsWith('NO PANE')) {
      // The pane appeared after the window did: a spawn we watched boot.
      attach();
    }
  }

  const off = store.on((e) => { if (e.k === 'agents' || e.k === 'world') render(); });
  render();
  window.setTimeout(attach, 0);

  return {
    dispose() {
      gone = true;
      off();
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      if (handle) { handle.close(); handle = null; }
      term.dispose();
    },
    update() { render(); },
  };
}
